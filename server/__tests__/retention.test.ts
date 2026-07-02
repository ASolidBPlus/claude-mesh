import { describe, it, expect } from 'bun:test';
import {
  openDb,
  insertMessage,
  markDelivered,
  getMessage,
  getPendingMessages,
  getPendingTopicMessages,
  queryMessages,
  countExpiredUndeliveredSince,
  sweepRetention,
} from '../db.ts';
import { drainQueue } from '../router.ts';
import { WebSocket } from 'ws';

// The #34 seam (retention vs delivery TTL). Two lifecycles, tested separately:
//   - DRAIN gate: an undelivered message past its TTL is never delivered
//     (getPendingMessages / getPendingTopicMessages / drainQueue) — unchanged.
//   - RETENTION vs history: delivered/expired rows are RETAINED as history
//     (expiry no longer deletes); the retention sweep is the only deleter and
//     it never removes still-deliverable pending mail.
// (Started as characterization of the pre-fix delete behavior; updated in the
//  fix commit to assert the retained-history behavior.)

// Minimal ws stub: drainQueue only calls ws.send().
function fakeWs(): WebSocket {
  const sent: string[] = [];
  return { send: (d: string) => { sent.push(d); }, _sent: sent } as unknown as WebSocket;
}

describe('#34 characterization — drain gate (PRESERVED by the fix)', () => {
  it('getPendingMessages excludes an undelivered message past its TTL', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    insertMessage(db, { id: 'u-exp', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1, expires_at: past });
    insertMessage(db, { id: 'u-live', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 2, expires_at: Date.now() + 60_000 });
    const pending = getPendingMessages(db, 'bob');
    expect(pending.map(m => m.id)).toEqual(['u-live']);
    db.close();
  });

  it('drainQueue does NOT deliver an undelivered message past its TTL', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    insertMessage(db, { id: 'd-exp', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1, expires_at: past });
    const delivered = drainQueue(db, 'bob', fakeWs());
    expect(delivered).toBe(0);
    // and it was NOT marked delivered
    expect(getMessage(db, 'd-exp')!.delivered_at).toBeNull();
    db.close();
  });

  it('getPendingTopicMessages excludes an undelivered topic message past its TTL (third drain path)', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    insertMessage(db, { id: 't-exp', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p', sent_at: 1, expires_at: past });
    insertMessage(db, { id: 't-live', kind: 'topic', from_agent: 'x', topic: 'news', payload: 'p', sent_at: 2, expires_at: Date.now() + 60_000 });
    const pending = getPendingTopicMessages(db, 'news');
    expect(pending.map(m => m.id)).toEqual(['t-live']);
    db.close();
  });
});

describe('#34 — delivered/expired history is RETAINED (the fix)', () => {
  it('a DELIVERED message past its TTL is not deleted and stays in GET /messages', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    const msg = insertMessage(db, { id: 'del-exp', kind: 'direct', from_agent: 'alice', to_agent: 'bob', payload: 'hi', sent_at: 1, expires_at: past });
    markDelivered(db, msg.id);

    // the windowed expiry count deletes nothing
    countExpiredUndeliveredSince(db, 0, Date.now());

    expect(getMessage(db, 'del-exp')).not.toBeNull();
    expect(queryMessages(db, { agent: 'bob' }).map(m => m.id)).toContain('del-exp');
    db.close();
  });

  it('an undelivered message past its TTL stays in the store (history) but is never delivered', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    insertMessage(db, { id: 'undel-exp', kind: 'direct', from_agent: 'alice', to_agent: 'bob', payload: 'hi', sent_at: 1, expires_at: past });

    countExpiredUndeliveredSince(db, 0, Date.now());

    // still visible as history...
    expect(queryMessages(db, { agent: 'bob' }).map(m => m.id)).toContain('undel-exp');
    // ...but its deliverability is dead (drain gate excludes it)
    expect(getPendingMessages(db, 'bob').map(m => m.id)).not.toContain('undel-exp');
    db.close();
  });

  it('retention never destroys still-deliverable pending mail, which still drains after the sweep', () => {
    const db = openDb(':memory:');
    const old = Date.now() - 100_000;
    // undelivered, ttl:null (never expires), addressed to a long-offline agent
    insertMessage(db, { id: 'mail', kind: 'direct', from_agent: 'a', to_agent: 'bob', payload: 'p', sent_at: old, expires_at: null });

    // aggressive retention (1ms) — the guard must still spare deliverable mail
    const removed = sweepRetention(db, 1);
    expect(removed).toBe(0);
    expect(getMessage(db, 'mail')).not.toBeNull();

    // and it still drains on reconnect
    const ws = fakeWs();
    expect(drainQueue(db, 'bob', ws)).toBe(1);
    expect(getMessage(db, 'mail')!.delivered_at).not.toBeNull();
    db.close();
  });
});
