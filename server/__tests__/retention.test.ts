import { describe, it, expect } from 'bun:test';
import {
  openDb,
  insertMessage,
  markDelivered,
  getMessage,
  getPendingMessages,
  getPendingTopicMessages,
  queryMessages,
  expireMessages,
} from '../db.ts';
import { drainQueue } from '../router.ts';
import { WebSocket } from 'ws';

// Characterization of the #34 seam (retention vs delivery TTL) on the CURRENT
// code. These pin today's behavior so the fix is a deliberate, visible change:
//   - the DRAIN gate (undelivered-past-TTL never drained) is PRESERVED by the fix;
//   - the CLEANUP behavior (expireMessages hard-deletes expired rows regardless
//     of delivered_at — the data-loss bug) is what CHANGES. The two assertions
//     tagged `[flips after #34]` will be updated in the fix commit.

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

describe('#34 characterization — cleanup (CHANGES with the fix)', () => {
  it('[flips after #34] expireMessages hard-deletes a DELIVERED message past its TTL (the data-loss bug)', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    const msg = insertMessage(db, { id: 'del-exp', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1, expires_at: past });
    markDelivered(db, msg.id);
    expect(getMessage(db, 'del-exp')!.delivered_at).not.toBeNull();

    expireMessages(db);

    // CURRENT behavior: the delivered message is gone (history destroyed).
    // After #34 this must become `.not.toBeNull()` (retained as history).
    expect(getMessage(db, 'del-exp')).toBeNull();
    db.close();
  });

  it('[flips after #34] a delivered+expired row disappears from GET /messages after cleanup', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    const msg = insertMessage(db, { id: 'q-exp', kind: 'direct', from_agent: 'alice', to_agent: 'bob', payload: 'hi', sent_at: 1, expires_at: past });
    markDelivered(db, msg.id);

    // before cleanup: visible in history
    expect(queryMessages(db, { agent: 'bob' }).map(m => m.id)).toContain('q-exp');
    expireMessages(db);
    // CURRENT: erased. After #34: still present.
    expect(queryMessages(db, { agent: 'bob' }).map(m => m.id)).not.toContain('q-exp');
    db.close();
  });

  it('expireMessages returns per-kind counts of the rows it removed', () => {
    const db = openDb(':memory:');
    const past = Date.now() - 5000;
    insertMessage(db, { id: 'k1', kind: 'direct', from_agent: 'x', to_agent: 'bob', payload: 'p', sent_at: 1, expires_at: past });
    insertMessage(db, { id: 'k2', kind: 'topic', from_agent: 'x', topic: 't', payload: 'p', sent_at: 2, expires_at: past });
    const counts = expireMessages(db);
    expect(counts.direct).toBe(1);
    expect(counts.topic).toBe(1);
    db.close();
  });
});
