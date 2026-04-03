import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  openDb,
  registerAgent,
  getAgentById,
  getAgentByToken,
  listAgents,
  touchAgent,
  setOnline,
  updateAgent,
  deleteAgent,
  aclGrant,
  aclRevoke,
  aclCheck,
  listInboundAcl,
  listOutboundAcl,
  insertMessage,
  markDelivered,
  markAcked,
  getPendingMessages,
  getPendingTopicMessages,
  getMessage,
  getMessageByCorrelationId,
  expireMessages,
  getOrCreateTopic,
  listTopics,
  deleteTopic,
  subscribe,
  unsubscribe,
  getTopicSubscribers,
  getAgentSubscriptions,
} from '../db';

// ──────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────

function freshDb(): Database {
  return openDb(':memory:');
}

function makeAgent(db: Database, id: string, token = 'secret-' + id) {
  const hash = hashToken(token);
  return registerAgent(db, { id, token_hash: hash, hostname: 'host-' + id });
}

// Replicate the hashing logic from db.ts for test use
function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(token);
  return hasher.digest('hex');
}

// ──────────────────────────────────────────────
// openDb
// ──────────────────────────────────────────────

describe('openDb', () => {
  it('openDb(:memory:) returns a Database instance without throwing', () => {
    const db = openDb(':memory:');
    expect(db).toBeInstanceOf(Database);
    db.close();
  });

  it('calling openDb on the same path a second time does not throw (schema is idempotent)', () => {
    const path = '/tmp/test-idempotent-' + Date.now() + '.db';
    const db1 = openDb(path);
    db1.close();
    expect(() => {
      const db2 = openDb(path);
      db2.close();
    }).not.toThrow();
  });

  it('PRAGMA journal_mode returns wal after openDb', () => {
    // WAL is not supported on :memory: databases; use a temp file to test
    const path = '/tmp/test-wal-' + Date.now() + '.db';
    const db = openDb(path);
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
    db.close();
  });

  it('PRAGMA foreign_keys returns 1 after openDb', () => {
    const db = openDb(':memory:');
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });
});

// ──────────────────────────────────────────────
// registerAgent / getAgentById
// ──────────────────────────────────────────────

describe('registerAgent / getAgentById', () => {
  it('registerAgent inserts a row; getAgentById returns it with matching id, token_hash, hostname', () => {
    const db = freshDb();
    const hash = hashToken('mytoken');
    registerAgent(db, { id: 'agent-1', token_hash: hash, hostname: 'host1' });
    const agent = getAgentById(db, 'agent-1');
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe('agent-1');
    expect(agent!.token_hash).toBe(hash);
    expect(agent!.hostname).toBe('host1');
  });

  it('registered_at and last_seen are set to a recent unix ms timestamp', () => {
    const db = freshDb();
    const before = Date.now();
    const agent = makeAgent(db, 'a1');
    const after = Date.now();
    expect(agent.registered_at).toBeGreaterThanOrEqual(before);
    expect(agent.registered_at).toBeLessThanOrEqual(after + 5000);
    expect(agent.last_seen).toBeGreaterThanOrEqual(before);
    expect(agent.last_seen).toBeLessThanOrEqual(after + 5000);
  });

  it('online defaults to 0', () => {
    const db = freshDb();
    const agent = makeAgent(db, 'a1');
    expect(agent.online).toBe(0);
  });

  it('capabilities defaults to [] when not provided', () => {
    const db = freshDb();
    const agent = makeAgent(db, 'a1');
    expect(agent.capabilities).toBe('[]');
  });

  it('metadata defaults to {} when not provided', () => {
    const db = freshDb();
    const agent = makeAgent(db, 'a1');
    expect(agent.metadata).toBe('{}');
  });

  it('registerAgent with a duplicate id throws', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    expect(() => makeAgent(db, 'a1')).toThrow();
  });
});

// ──────────────────────────────────────────────
// getAgentByToken
// ──────────────────────────────────────────────

describe('getAgentByToken', () => {
  it('getAgentByToken with the correct raw token returns the agent row', () => {
    const db = freshDb();
    const hash = hashToken('my-secret-token');
    registerAgent(db, { id: 'agent-tok', token_hash: hash, hostname: 'host1' });
    const found = getAgentByToken(db, 'my-secret-token');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('agent-tok');
  });

  it('getAgentByToken with an incorrect token returns null', () => {
    const db = freshDb();
    const hash = hashToken('correct-token');
    registerAgent(db, { id: 'agent-tok', token_hash: hash, hostname: 'host1' });
    const found = getAgentByToken(db, 'wrong-token');
    expect(found).toBeNull();
  });

  it('getAgentByToken with a token that matches no stored hash returns null', () => {
    const db = freshDb();
    const found = getAgentByToken(db, 'nonexistent-token');
    expect(found).toBeNull();
  });
});

// ──────────────────────────────────────────────
// listAgents
// ──────────────────────────────────────────────

describe('listAgents', () => {
  it('listAgents returns all inserted agents', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    makeAgent(db, 'a2');
    makeAgent(db, 'a3');
    const agents = listAgents(db);
    expect(agents.length).toBe(3);
  });

  it('listAgents(db, true) returns only agents where online = 1', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    makeAgent(db, 'a2');
    makeAgent(db, 'a3');
    setOnline(db, 'a1', true);
    setOnline(db, 'a3', true);
    const online = listAgents(db, true);
    expect(online.length).toBe(2);
    expect(online.map(a => a.id).sort()).toEqual(['a1', 'a3']);
  });

  it('listAgents on an empty db returns []', () => {
    const db = freshDb();
    expect(listAgents(db)).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// touchAgent
// ──────────────────────────────────────────────

describe('touchAgent', () => {
  it('touchAgent updates last_seen to a value >= the value before the call', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    const before = getAgentById(db, 'a1')!.last_seen;
    touchAgent(db, 'a1');
    const after = getAgentById(db, 'a1')!.last_seen;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('touchAgent with a non-existent id does not throw', () => {
    const db = freshDb();
    expect(() => touchAgent(db, 'nonexistent')).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// setOnline
// ──────────────────────────────────────────────

describe('setOnline', () => {
  it('setOnline(db, id, true) sets online = 1 and updates last_seen', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    const before = getAgentById(db, 'a1')!.last_seen;
    setOnline(db, 'a1', true);
    const agent = getAgentById(db, 'a1')!;
    expect(agent.online).toBe(1);
    expect(agent.last_seen).toBeGreaterThanOrEqual(before);
  });

  it('setOnline(db, id, false) sets online = 0', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    setOnline(db, 'a1', true);
    setOnline(db, 'a1', false);
    expect(getAgentById(db, 'a1')!.online).toBe(0);
  });

  it('setOnline with a non-existent id does not throw', () => {
    const db = freshDb();
    expect(() => setOnline(db, 'nonexistent', true)).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// deleteAgent
// ──────────────────────────────────────────────

describe('deleteAgent', () => {
  it('deleteAgent removes the row; subsequent getAgentById returns null', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    deleteAgent(db, 'a1');
    expect(getAgentById(db, 'a1')).toBeNull();
  });

  it('deleting an agent cascades: ACL rows referencing that agent as from_agent or to_agent are deleted', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    makeAgent(db, 'a2');
    aclGrant(db, 'a1', 'a2', 'system');
    aclGrant(db, 'a2', 'a1', 'system');
    deleteAgent(db, 'a1');
    // Both ACL rows should be gone
    expect(aclCheck(db, 'a1', 'a2')).toBe(false);
    expect(aclCheck(db, 'a2', 'a1')).toBe(false);
  });

  it('deleting an agent cascades: subscription rows for that agent are deleted', () => {
    const db = freshDb();
    // Use a separate creator so deleting the subscriber doesn't hit the topics FK
    makeAgent(db, 'creator');
    makeAgent(db, 'subscriber');
    getOrCreateTopic(db, 'test-topic', 'creator');
    subscribe(db, 'subscriber', 'test-topic');
    deleteAgent(db, 'subscriber');
    expect(getTopicSubscribers(db, 'test-topic')).toEqual([]);
  });

  it('deleteAgent with a non-existent id does not throw', () => {
    const db = freshDb();
    expect(() => deleteAgent(db, 'nonexistent')).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// updateAgent
// ──────────────────────────────────────────────

describe('updateAgent', () => {
  it('updateAgent with capabilities updates that field; other fields remain unchanged', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    const orig = getAgentById(db, 'a1')!;
    updateAgent(db, 'a1', { capabilities: '["broadcast"]' });
    const updated = getAgentById(db, 'a1')!;
    expect(updated.capabilities).toBe('["broadcast"]');
    expect(updated.hostname).toBe(orig.hostname);
    expect(updated.metadata).toBe(orig.metadata);
  });

  it('updateAgent with metadata updates that field; other fields remain unchanged', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    const orig = getAgentById(db, 'a1')!;
    updateAgent(db, 'a1', { metadata: '{"region":"eu"}' });
    const updated = getAgentById(db, 'a1')!;
    expect(updated.metadata).toBe('{"region":"eu"}');
    expect(updated.hostname).toBe(orig.hostname);
    expect(updated.capabilities).toBe(orig.capabilities);
  });

  it('updateAgent with hostname updates that field; other fields remain unchanged', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    const orig = getAgentById(db, 'a1')!;
    updateAgent(db, 'a1', { hostname: 'new-host' });
    const updated = getAgentById(db, 'a1')!;
    expect(updated.hostname).toBe('new-host');
    expect(updated.capabilities).toBe(orig.capabilities);
    expect(updated.metadata).toBe(orig.metadata);
  });

  it('updateAgent with multiple fields updates all provided fields simultaneously', () => {
    const db = freshDb();
    makeAgent(db, 'a1');
    updateAgent(db, 'a1', { hostname: 'new-host', capabilities: '["x"]', metadata: '{"k":"v"}' });
    const updated = getAgentById(db, 'a1')!;
    expect(updated.hostname).toBe('new-host');
    expect(updated.capabilities).toBe('["x"]');
    expect(updated.metadata).toBe('{"k":"v"}');
  });

  it('updateAgent with an unknown id returns null and does not throw', () => {
    const db = freshDb();
    expect(() => {
      const result = updateAgent(db, 'nonexistent', { hostname: 'x' });
      expect(result).toBeNull();
    }).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// aclGrant / aclCheck / aclRevoke
// ──────────────────────────────────────────────

describe('aclGrant / aclCheck / aclRevoke', () => {
  it('aclGrant(db, a, b, system) creates a row; aclCheck(db, a, b) returns true', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    makeAgent(db, 'b');
    aclGrant(db, 'a', 'b', 'system');
    expect(aclCheck(db, 'a', 'b')).toBe(true);
  });

  it('aclCheck(db, b, a) returns false (ACL is directional)', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    makeAgent(db, 'b');
    aclGrant(db, 'a', 'b', 'system');
    expect(aclCheck(db, 'b', 'a')).toBe(false);
  });

  it('aclGrant called again for the same pair does not throw and updates granted_at / granted_by', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    makeAgent(db, 'b');
    aclGrant(db, 'a', 'b', 'system');
    const row1 = db.prepare('SELECT * FROM acl WHERE from_agent = ? AND to_agent = ?').get('a', 'b') as { granted_at: number; granted_by: string };
    // small sleep is unnecessary — Date.now() may be same ms, just check it doesn't throw
    expect(() => aclGrant(db, 'a', 'b', 'orchestrator')).not.toThrow();
    const row2 = db.prepare('SELECT * FROM acl WHERE from_agent = ? AND to_agent = ?').get('a', 'b') as { granted_at: number; granted_by: string };
    expect(row2.granted_by).toBe('orchestrator');
    expect(row2.granted_at).toBeGreaterThanOrEqual(row1.granted_at);
  });

  it('aclRevoke(db, a, b) removes the row; subsequent aclCheck returns false', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    makeAgent(db, 'b');
    aclGrant(db, 'a', 'b', 'system');
    aclRevoke(db, 'a', 'b');
    expect(aclCheck(db, 'a', 'b')).toBe(false);
  });

  it('aclRevoke on a non-existent row does not throw', () => {
    const db = freshDb();
    expect(() => aclRevoke(db, 'x', 'y')).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// listInboundAcl / listOutboundAcl
// ──────────────────────────────────────────────

describe('listInboundAcl / listOutboundAcl', () => {
  it('listInboundAcl(db, b) returns only rows where to_agent = b', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    makeAgent(db, 'b');
    makeAgent(db, 'c');
    aclGrant(db, 'a', 'b', 'system');
    aclGrant(db, 'c', 'b', 'system');
    aclGrant(db, 'a', 'c', 'system');
    const rows = listInboundAcl(db, 'b');
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.to_agent === 'b')).toBe(true);
  });

  it('listOutboundAcl(db, a) returns only rows where from_agent = a', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    makeAgent(db, 'b');
    makeAgent(db, 'c');
    aclGrant(db, 'a', 'b', 'system');
    aclGrant(db, 'a', 'c', 'system');
    aclGrant(db, 'b', 'c', 'system');
    const rows = listOutboundAcl(db, 'a');
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.from_agent === 'a')).toBe(true);
  });

  it('both return [] when no matching rows exist', () => {
    const db = freshDb();
    makeAgent(db, 'a');
    expect(listInboundAcl(db, 'a')).toEqual([]);
    expect(listOutboundAcl(db, 'a')).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// insertMessage / getMessage
// ──────────────────────────────────────────────

describe('insertMessage / getMessage', () => {
  it('insertMessage with required fields inserts a row; getMessage returns it with correct values', () => {
    const db = freshDb();
    const msg = insertMessage(db, {
      id: 'msg-1',
      kind: 'direct',
      from_agent: 'sender',
      payload: 'hello',
      sent_at: Date.now(),
    });
    const fetched = getMessage(db, 'msg-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('msg-1');
    expect(fetched!.kind).toBe('direct');
    expect(fetched!.from_agent).toBe('sender');
    expect(fetched!.payload).toBe('hello');
  });

  it('to_agent, topic, correlation_id, expires_at, delivered_at, acked_at default to null', () => {
    const db = freshDb();
    insertMessage(db, { id: 'msg-2', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: Date.now() });
    const msg = getMessage(db, 'msg-2')!;
    expect(msg.to_agent).toBeNull();
    expect(msg.topic).toBeNull();
    expect(msg.correlation_id).toBeNull();
    expect(msg.expires_at).toBeNull();
    expect(msg.delivered_at).toBeNull();
    expect(msg.acked_at).toBeNull();
  });

  it('content_type defaults to text/plain', () => {
    const db = freshDb();
    insertMessage(db, { id: 'msg-3', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: Date.now() });
    expect(getMessage(db, 'msg-3')!.content_type).toBe('text/plain');
  });

  it('getMessage with an unknown id returns null', () => {
    const db = freshDb();
    expect(getMessage(db, 'no-such-id')).toBeNull();
  });

  it('insertMessage with a duplicate id throws', () => {
    const db = freshDb();
    insertMessage(db, { id: 'dup-id', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: Date.now() });
    expect(() => insertMessage(db, { id: 'dup-id', kind: 'direct', from_agent: 'y', payload: 'q', sent_at: Date.now() })).toThrow();
  });
});

// ──────────────────────────────────────────────
// markDelivered / markAcked
// ──────────────────────────────────────────────

describe('markDelivered / markAcked', () => {
  it('markDelivered sets delivered_at to a recent unix ms; getMessage reflects the change', () => {
    const db = freshDb();
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: Date.now() });
    const before = Date.now();
    markDelivered(db, 'm1');
    const msg = getMessage(db, 'm1')!;
    expect(msg.delivered_at).not.toBeNull();
    expect(msg.delivered_at!).toBeGreaterThanOrEqual(before);
  });

  it('markAcked sets acked_at to a recent unix ms; getMessage reflects the change', () => {
    const db = freshDb();
    insertMessage(db, { id: 'm2', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: Date.now() });
    const before = Date.now();
    markAcked(db, 'm2');
    const msg = getMessage(db, 'm2')!;
    expect(msg.acked_at).not.toBeNull();
    expect(msg.acked_at!).toBeGreaterThanOrEqual(before);
  });

  it('markDelivered with a non-existent id does not throw', () => {
    const db = freshDb();
    expect(() => markDelivered(db, 'no-such')).not.toThrow();
  });

  it('markAcked with a non-existent id does not throw', () => {
    const db = freshDb();
    expect(() => markAcked(db, 'no-such')).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// getPendingMessages
// ──────────────────────────────────────────────

describe('getPendingMessages', () => {
  it('returns only rows where to_agent = agentId AND delivered_at IS NULL', () => {
    const db = freshDb();
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p1', sent_at: 1 });
    insertMessage(db, { id: 'm2', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p2', sent_at: 2 });
    insertMessage(db, { id: 'm3', kind: 'direct', from_agent: 'x', to_agent: 'alice', payload: 'p3', sent_at: 3 });
    markDelivered(db, 'm2');
    const pending = getPendingMessages(db, 'bob');
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe('m1');
  });

  it('excludes rows where expires_at IS NOT NULL AND expires_at < Date.now()', () => {
    const db = freshDb();
    const expired = Date.now() - 10000;
    insertMessage(db, { id: 'exp', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1, expires_at: expired });
    const pending = getPendingMessages(db, 'bob');
    expect(pending.find(m => m.id === 'exp')).toBeUndefined();
  });

  it('rows where expires_at IS NULL are included regardless of time', () => {
    const db = freshDb();
    insertMessage(db, { id: 'no-exp', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1, expires_at: null });
    const pending = getPendingMessages(db, 'bob');
    expect(pending.find(m => m.id === 'no-exp')).toBeDefined();
  });

  it('returns [] when all messages to that agent are already delivered', () => {
    const db = freshDb();
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1 });
    markDelivered(db, 'm1');
    expect(getPendingMessages(db, 'bob')).toEqual([]);
  });

  it('results are ordered by sent_at ASC', () => {
    const db = freshDb();
    insertMessage(db, { id: 'm3', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p3', sent_at: 300 });
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p1', sent_at: 100 });
    insertMessage(db, { id: 'm2', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p2', sent_at: 200 });
    const pending = getPendingMessages(db, 'bob');
    expect(pending.map(m => m.id)).toEqual(['m1', 'm2', 'm3']);
  });
});

// ──────────────────────────────────────────────
// getPendingTopicMessages
// ──────────────────────────────────────────────

describe('getPendingTopicMessages', () => {
  it('returns only rows where topic = topicName AND delivered_at IS NULL', () => {
    const db = freshDb();
    insertMessage(db, { id: 't1', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p1', sent_at: 1 });
    insertMessage(db, { id: 't2', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p2', sent_at: 2 });
    insertMessage(db, { id: 't3', kind: 'topic', from_agent: 'x', topic: 'other', payload: 'p3', sent_at: 3 });
    markDelivered(db, 't2');
    const pending = getPendingTopicMessages(db, 'news');
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe('t1');
  });

  it('excludes expired rows; includes non-expiring rows', () => {
    const db = freshDb();
    const expired = Date.now() - 5000;
    const future = Date.now() + 60000;
    insertMessage(db, { id: 'e1', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p', sent_at: 1, expires_at: expired });
    insertMessage(db, { id: 'e2', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p', sent_at: 2, expires_at: future });
    insertMessage(db, { id: 'e3', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p', sent_at: 3, expires_at: null });
    const pending = getPendingTopicMessages(db, 'news');
    const ids = pending.map(m => m.id);
    expect(ids).not.toContain('e1');
    expect(ids).toContain('e2');
    expect(ids).toContain('e3');
  });

  it('returns [] when no pending messages exist for that topic', () => {
    const db = freshDb();
    expect(getPendingTopicMessages(db, 'empty-topic')).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// getMessageByCorrelationId
// ──────────────────────────────────────────────

describe('getMessageByCorrelationId', () => {
  it('returns the message whose correlation_id matches', () => {
    const db = freshDb();
    insertMessage(db, { id: 'req-1', kind: 'request', from_agent: 'x', payload: 'request', sent_at: 100, correlation_id: 'corr-abc' });
    const msg = getMessageByCorrelationId(db, 'corr-abc');
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe('req-1');
  });

  it('returns null when no message matches', () => {
    const db = freshDb();
    expect(getMessageByCorrelationId(db, 'no-such-corr')).toBeNull();
  });
});

// ──────────────────────────────────────────────
// expireMessages
// ──────────────────────────────────────────────

describe('expireMessages', () => {
  it('deletes rows where expires_at < Date.now() and returns the deleted count', () => {
    const db = freshDb();
    const pastTime = Date.now() - 10000;
    insertMessage(db, { id: 'old1', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: 1, expires_at: pastTime });
    insertMessage(db, { id: 'old2', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: 2, expires_at: pastTime });
    const count = expireMessages(db);
    expect(count).toBe(2);
    expect(getMessage(db, 'old1')).toBeNull();
    expect(getMessage(db, 'old2')).toBeNull();
  });

  it('does not delete rows where expires_at IS NULL', () => {
    const db = freshDb();
    insertMessage(db, { id: 'keep1', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: 1, expires_at: null });
    expireMessages(db);
    expect(getMessage(db, 'keep1')).not.toBeNull();
  });

  it('does not delete rows where expires_at >= Date.now()', () => {
    const db = freshDb();
    const futureTime = Date.now() + 60000;
    insertMessage(db, { id: 'keep2', kind: 'direct', from_agent: 'x', payload: 'p', sent_at: 1, expires_at: futureTime });
    expireMessages(db);
    expect(getMessage(db, 'keep2')).not.toBeNull();
  });

  it('returns 0 when no rows qualify for deletion', () => {
    const db = freshDb();
    expect(expireMessages(db)).toBe(0);
  });
});

// ──────────────────────────────────────────────
// getOrCreateTopic / listTopics / deleteTopic
// ──────────────────────────────────────────────

describe('getOrCreateTopic / listTopics / deleteTopic', () => {
  it('getOrCreateTopic inserts and returns the topic on first call', () => {
    const db = freshDb();
    makeAgent(db, 'creator');
    const topic = getOrCreateTopic(db, 'game:moves', 'creator', 'Move events', '{"maxSubs":10}');
    expect(topic.name).toBe('game:moves');
    expect(topic.created_by).toBe('creator');
    expect(topic.description).toBe('Move events');
    expect(topic.metadata).toBe('{"maxSubs":10}');
  });

  it('getOrCreateTopic called again for the same name returns the existing row without modification', () => {
    const db = freshDb();
    makeAgent(db, 'creator');
    const first = getOrCreateTopic(db, 'events', 'creator');
    // small pause to ensure any new insert would have a different created_at
    const second = getOrCreateTopic(db, 'events', 'creator', 'Different desc', '{"changed":true}');
    expect(second.created_at).toBe(first.created_at);
    expect(second.description).toBe(first.description);
    expect(second.metadata).toBe(first.metadata);
  });

  it('listTopics returns all topics ordered by name ASC', () => {
    const db = freshDb();
    makeAgent(db, 'creator');
    getOrCreateTopic(db, 'zebra', 'creator');
    getOrCreateTopic(db, 'alpha', 'creator');
    getOrCreateTopic(db, 'middle', 'creator');
    const topics = listTopics(db);
    expect(topics.map(t => t.name)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('deleteTopic removes the topic; subsequent listTopics does not include it', () => {
    const db = freshDb();
    makeAgent(db, 'creator');
    getOrCreateTopic(db, 'to-delete', 'creator');
    deleteTopic(db, 'to-delete');
    expect(listTopics(db).find(t => t.name === 'to-delete')).toBeUndefined();
  });

  it('deleting a topic cascades: subscription rows for that topic are deleted', () => {
    const db = freshDb();
    makeAgent(db, 'creator');
    makeAgent(db, 'subscriber');
    getOrCreateTopic(db, 'temp-topic', 'creator');
    subscribe(db, 'subscriber', 'temp-topic');
    deleteTopic(db, 'temp-topic');
    expect(getTopicSubscribers(db, 'temp-topic')).toEqual([]);
    expect(getAgentSubscriptions(db, 'subscriber')).toEqual([]);
  });

  it('deleteTopic with a non-existent name does not throw', () => {
    const db = freshDb();
    expect(() => deleteTopic(db, 'nonexistent-topic')).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// subscribe / unsubscribe / getTopicSubscribers / getAgentSubscriptions
// ──────────────────────────────────────────────

describe('subscribe / unsubscribe / getTopicSubscribers / getAgentSubscriptions', () => {
  it('subscribe inserts a subscription row; getTopicSubscribers returns the agent_id', () => {
    const db = freshDb();
    makeAgent(db, 'agent1');
    getOrCreateTopic(db, 'news', 'agent1');
    subscribe(db, 'agent1', 'news');
    expect(getTopicSubscribers(db, 'news')).toContain('agent1');
  });

  it('subscribe called again for the same pair does not throw and returns original subscribed_at unchanged', () => {
    const db = freshDb();
    makeAgent(db, 'agent1');
    getOrCreateTopic(db, 'news', 'agent1');
    const first = subscribe(db, 'agent1', 'news');
    expect(() => {
      const second = subscribe(db, 'agent1', 'news');
      expect(second.subscribed_at).toBe(first.subscribed_at);
    }).not.toThrow();
  });

  it('getTopicSubscribers returns [] when no agents are subscribed', () => {
    const db = freshDb();
    expect(getTopicSubscribers(db, 'empty-topic')).toEqual([]);
  });

  it('getAgentSubscriptions returns all topic names the agent is subscribed to', () => {
    const db = freshDb();
    makeAgent(db, 'agent1');
    getOrCreateTopic(db, 'news', 'agent1');
    getOrCreateTopic(db, 'alerts', 'agent1');
    subscribe(db, 'agent1', 'news');
    subscribe(db, 'agent1', 'alerts');
    const subs = getAgentSubscriptions(db, 'agent1');
    expect(subs.sort()).toEqual(['alerts', 'news']);
  });

  it('getAgentSubscriptions returns [] when the agent has no subscriptions', () => {
    const db = freshDb();
    makeAgent(db, 'agent1');
    expect(getAgentSubscriptions(db, 'agent1')).toEqual([]);
  });

  it('unsubscribe removes the row; subsequent getTopicSubscribers does not include the agent', () => {
    const db = freshDb();
    makeAgent(db, 'agent1');
    getOrCreateTopic(db, 'news', 'agent1');
    subscribe(db, 'agent1', 'news');
    unsubscribe(db, 'agent1', 'news');
    expect(getTopicSubscribers(db, 'news')).not.toContain('agent1');
  });

  it('unsubscribe on a non-existent row does not throw', () => {
    const db = freshDb();
    expect(() => unsubscribe(db, 'nobody', 'no-topic')).not.toThrow();
  });
});

// ──────────────────────────────────────────────
// Referential integrity (FK enforcement)
// ──────────────────────────────────────────────

describe('Referential integrity (FK enforcement)', () => {
  it('inserting an ACL row with a non-existent from_agent throws a FK violation', () => {
    const db = freshDb();
    makeAgent(db, 'real-agent');
    expect(() => {
      db.prepare('INSERT INTO acl (from_agent, to_agent, granted_at, granted_by) VALUES (?, ?, ?, ?)')
        .run('ghost', 'real-agent', Date.now(), 'system');
    }).toThrow();
  });

  it('inserting an ACL row with a non-existent to_agent throws a FK violation', () => {
    const db = freshDb();
    makeAgent(db, 'real-agent');
    expect(() => {
      db.prepare('INSERT INTO acl (from_agent, to_agent, granted_at, granted_by) VALUES (?, ?, ?, ?)')
        .run('real-agent', 'ghost', Date.now(), 'system');
    }).toThrow();
  });

  it('inserting a subscription row with a non-existent agent_id throws a FK violation', () => {
    const db = freshDb();
    makeAgent(db, 'creator');
    getOrCreateTopic(db, 'mytopic', 'creator');
    expect(() => {
      db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?, ?, ?)')
        .run('ghost-agent', 'mytopic', Date.now());
    }).toThrow();
  });

  it('inserting a subscription row with a non-existent topic throws a FK violation', () => {
    const db = freshDb();
    makeAgent(db, 'agent1');
    expect(() => {
      db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?, ?, ?)')
        .run('agent1', 'ghost-topic', Date.now());
    }).toThrow();
  });

  it('inserting a topic row with a non-existent created_by agent throws a FK violation', () => {
    const db = freshDb();
    expect(() => {
      db.prepare('INSERT INTO topics (name, created_at, created_by, description, metadata) VALUES (?, ?, ?, ?, ?)')
        .run('new-topic', Date.now(), 'ghost-creator', '', '{}');
    }).toThrow();
  });
});
