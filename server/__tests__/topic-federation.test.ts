import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, aclGrant, getOrCreateTopic, subscribe, upsertPeer } from '../db.ts';
import { hashToken } from '../auth.ts';
import { routePublish } from '../router.ts';

// F4 — topics across peerings. This file grows one commit at a time; the
// three-mesh fixture arrives with the border commits.
//
// Commit 3's question is the one that has to be settled before any frame
// crosses anything: a `subscriptions` row may now name a REMOTE id, and the
// LOCAL fan-out must not try to deliver to it. Nothing else in the suite can
// see that, because before commit 1 such a row could not exist.

describe('F4 local fan-out skips remote subscribers', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'pub', token_hash: hashToken('p'), hostname: 'h' });
    registerAgent(db, { id: 'local-sub', token_hash: hashToken('s'), hostname: 'h' });
    aclGrant(db, 'pub', 'local-sub', 'system');
    getOrCreateTopic(db, 'trollbox', 'pub');
    // The peering exists so the grant to a remote id is permitted; the fan-out
    // must skip the subscriber regardless.
    upsertPeer(db, {
      alias: 'pod1', token_hash: hashToken('t'), minted_by_key: 'k',
      kinds: '["topic"]', rate_per_min: 600,
    });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('pod1','wss://pod1.example','tok','orch','["topic"]',600,?)`).run(Date.now());
    aclGrant(db, 'pub', 'pod1:alice', 'system');
  });
  afterEach(() => { db.close(); });

  const rowsTo = (to: string) =>
    (db.prepare('SELECT COUNT(*) c FROM messages WHERE to_agent = ?').get(to) as { c: number }).c;

  // A remote subscriber is not deliverable BY THIS MESH. A `messages` row
  // addressed to `pod1:alice` is not a topic delivery — it is what the DIRECT
  // border path writes, addressed `pod1:` with the remote in the frame — so a
  // row like this would sit in the queue forever, matched by no drain range and
  // read by nobody.
  it('a remote subscription row produces no local delivery row', () => {
    subscribe(db, 'pod1:alice', 'trollbox');
    subscribe(db, 'local-sub', 'trollbox');
    // POSITIVE CONTROL on the fixture: both rows really are there, so "no row
    // for the remote one" is the filter and not an empty subscriber list.
    expect(db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE topic = ?').get('trollbox')).toEqual({ c: 2 });

    const result = routePublish(db, new Map(), 'pub', { type: 'publish', topic: 'trollbox', payload: 'hi' } as never);
    expect(result.ok).toBe(true);

    expect(rowsTo('pod1:alice')).toBe(0);
    // ...and the LOCAL subscriber was still served, so the filter did not
    // simply empty the list.
    expect(rowsTo('local-sub')).toBe(1);
  });

  // The filter is `isRemoteEndpoint`, which is an AGENT LOOKUP and not a colon
  // test: a legacy local agent whose id contains ':' is a preserved population
  // and must still receive its topics.
  it('CONTROL: a legacy colon id that IS a local agent still receives', () => {
    db.prepare('INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen) VALUES (?,?,?,?,?)')
      .run('legacy:agent', hashToken('l'), 'h', 1, 1);
    aclGrant(db, 'pub', 'legacy:agent', 'system');
    subscribe(db, 'legacy:agent', 'trollbox');

    routePublish(db, new Map(), 'pub', { type: 'publish', topic: 'trollbox', payload: 'hi' } as never);

    expect(rowsTo('legacy:agent')).toBe(1);
  });
});
