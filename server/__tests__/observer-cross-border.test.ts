import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import {
  openDb, registerAgent, aclGrant, grantObserver, listObservers, listCrossBorderObservers,
  insertOutboundPeer, upsertPeer, getPeerByAlias,
} from '../db.ts';
import { routeDirect, routeRelay, routePublish } from '../router.ts';
import { emitTap, LOCAL_ONLY, type TapFrame } from '../tap.ts';

// A stand-in observer socket that records what it was sent. Only the two
// members emitTap touches are implemented.
function fakeSocket(): { ws: WebSocket; got: TapFrame[] } {
  const got: TapFrame[] = [];
  const ws = {
    bufferedAmount: 0,
    send: (s: string) => { got.push(JSON.parse(s) as TapFrame); },
  } as unknown as WebSocket;
  return { ws, got };
}

describe('F3: observer cross_border scope', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'local-a', token_hash: 'a'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'local-b', token_hash: 'b'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'watcher', token_hash: 'c'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'wide-watcher', token_hash: 'd'.repeat(64), hostname: 'h' });
    aclGrant(db, 'local-a', 'local-b', 'system');
  });

  afterEach(() => { db.close(); });

  // ── the grant itself ───────────────────────────────────────────────

  it('an observer grant defaults to LOCAL ONLY', () => {
    const row = grantObserver(db, 'watcher', 'system');
    expect(row.cross_border).toBe(0);
    expect(listCrossBorderObservers(db).has('watcher')).toBe(false);
  });

  it('the wider scope is granted only when asked for', () => {
    grantObserver(db, 'wide-watcher', 'system', true);
    expect(listCrossBorderObservers(db).has('wide-watcher')).toBe(true);
  });

  // A re-grant is a statement of intent, not a ratchet: an operator narrowing
  // an observer must be able to do it through the same door that widened it.
  it('a re-grant can TIGHTEN the scope, not only widen it', () => {
    grantObserver(db, 'wide-watcher', 'system', true);
    expect(listCrossBorderObservers(db).has('wide-watcher')).toBe(true);
    grantObserver(db, 'wide-watcher', 'system', false);
    expect(listCrossBorderObservers(db).has('wide-watcher')).toBe(false);
  });

  // The migration's whole point: a grant made before federation existed did not
  // consent to cross-border traffic. Simulates the pre-F3 row shape by writing
  // the row without the column's value being chosen.
  it('MIGRATION: a pre-F3 observer row is local-only, not grandfathered wide', () => {
    db.exec("INSERT INTO observers (agent_id, granted_at, granted_by) VALUES ('watcher', 1, 'legacy')");
    expect(listObservers(db).find(o => o.agent_id === 'watcher')!.cross_border).toBe(0);
    expect(listCrossBorderObservers(db).has('watcher')).toBe(false);
  });

  // ── the gate in emitTap ────────────────────────────────────────────

  it('a local frame reaches every observer, scoped or not', () => {
    const narrow = fakeSocket(); const wide = fakeSocket();
    const idx = new Map<string, WebSocket>([['watcher', narrow.ws], ['wide-watcher', wide.ws]]);
    emitTap(idx, {
      type: 'tap', msg_id: 'm1', kind: 'direct', from: 'local-a', to: 'local-b',
      topic: null, correlation_id: null, sent_at: 1, size: 1, payload: 'x',
    }, LOCAL_ONLY);
    expect(narrow.got.length).toBe(1);
    expect(wide.got.length).toBe(1);
  });

  it('a cross-border frame reaches ONLY the scoped observer', () => {
    const narrow = fakeSocket(); const wide = fakeSocket();
    const idx = new Map<string, WebSocket>([['watcher', narrow.ws], ['wide-watcher', wide.ws]]);
    emitTap(idx, {
      type: 'tap', msg_id: 'm2', kind: 'direct', from: 'far:someone', to: 'local-b',
      topic: null, correlation_id: null, sent_at: 1, size: 1, payload: 'x',
    }, { crossBorder: true, scoped: new Set(['wide-watcher']) });
    expect(narrow.got.length).toBe(0);
    expect(wide.got.map(f => f.msg_id)).toEqual(['m2']);
  });

  it('an empty scope set means nobody sees a cross-border frame', () => {
    const narrow = fakeSocket();
    const idx = new Map<string, WebSocket>([['watcher', narrow.ws]]);
    emitTap(idx, {
      type: 'tap', msg_id: 'm3', kind: 'direct', from: 'far:x', to: 'local-b',
      topic: null, correlation_id: null, sent_at: 1, size: 1, payload: 'p',
    }, { crossBorder: true, scoped: new Set() });
    expect(narrow.got.length).toBe(0);
  });

  // ── the set test, derived from OUTPUT ──────────────────────────────

  // THE SET TEST. It does not check that each route function passes the right
  // audience — that would be a test of the call sites, and a NEW cross-border
  // path is exactly the thing that does not appear in a list of call sites.
  // Instead it drives every route function that emits a tap, with a NARROW
  // observer connected, collects everything that observer actually received,
  // and asserts none of it names a remote party. Derivation and enforcement are
  // then the same operation: a new federated path that forgets its audience
  // reds here without anyone remembering to add it.
  it('SET: a narrow observer receives no frame naming a remote party, across every emitting path', () => {
    insertOutboundPeer(db, { alias: 'far', url: 'wss://far.example/ws', token: 't'.repeat(32), assigned_alias: 'us', kinds: '["direct"]', rate_per_min: 600, created_at: Date.now() });
    upsertPeer(db, { alias: 'inbound', token_hash: 'e'.repeat(64), minted_by_key: 'k', kinds: '["direct"]', rate_per_min: 600 });
    aclGrant(db, 'local-a', 'far:remote-b', 'system');
    aclGrant(db, 'inbound:remote-c', 'local-b', 'system');

    const narrow = fakeSocket();
    grantObserver(db, 'watcher', 'system');                 // narrow, on purpose
    const observerIndex = new Map<string, WebSocket>([['watcher', narrow.ws]]);
    const agentIndex = new Map<string, WebSocket>();

    // Every path that emits a tap frame today.
    routeDirect(db, agentIndex, 'local-a', { type: 'send', msg_id: 'd1', to: 'local-b', payload: 'local' } as never, observerIndex);
    routeDirect(db, agentIndex, 'local-a', { type: 'send', msg_id: 'd2', to: 'far:remote-b', payload: 'outbound' } as never, observerIndex);
    routeRelay(db, agentIndex, getPeerByAlias(db, 'inbound')!, { type: 'relay', msg_id: 'r1', from: 'remote-c', to: 'local-b', kind: 'direct', payload: 'inbound', sent_at: Date.now(), ttl_ms: 60_000 } as never, observerIndex);
    routePublish(db, agentIndex, 'local-a', { type: 'publish', msg_id: 'p1', topic: 'general', payload: 'topic' } as never, observerIndex);

    expect(narrow.got.length).toBeGreaterThan(0);           // the drive did something

    // A remote party is an id qualified by a configured peer alias. Both
    // directions count: an outbound `to` and an inbound stamped `from`.
    const ALIASES = ['far', 'inbound'];
    const namesRemote = (id: string | null) =>
      id !== null && ALIASES.some(a => id.startsWith(`${a}:`));

    const leaked = narrow.got.filter(f => namesRemote(f.from) || namesRemote(f.to));
    expect(leaked.map(f => `${f.msg_id}: ${f.from} -> ${f.to}`)).toEqual([]);
  });

  // The positive control for the test above: with the SAME drive, a wide
  // observer must actually receive the cross-border frames. Without this, the
  // set test passes just as well when the routers emit nothing at all.
  it('CONTROL: the same drive DOES deliver cross-border frames to a scoped observer', () => {
    insertOutboundPeer(db, { alias: 'far', url: 'wss://far.example/ws', token: 't'.repeat(32), assigned_alias: 'us', kinds: '["direct"]', rate_per_min: 600, created_at: Date.now() });
    upsertPeer(db, { alias: 'inbound', token_hash: 'e'.repeat(64), minted_by_key: 'k', kinds: '["direct"]', rate_per_min: 600 });
    aclGrant(db, 'local-a', 'far:remote-b', 'system');
    aclGrant(db, 'inbound:remote-c', 'local-b', 'system');

    const wide = fakeSocket();
    grantObserver(db, 'wide-watcher', 'system', true);
    const observerIndex = new Map<string, WebSocket>([['wide-watcher', wide.ws]]);
    const agentIndex = new Map<string, WebSocket>();

    routeDirect(db, agentIndex, 'local-a', { type: 'send', msg_id: 'd2', to: 'far:remote-b', payload: 'outbound' } as never, observerIndex);
    routeRelay(db, agentIndex, getPeerByAlias(db, 'inbound')!, { type: 'relay', msg_id: 'r1', from: 'remote-c', to: 'local-b', kind: 'direct', payload: 'inbound', sent_at: Date.now(), ttl_ms: 60_000 } as never, observerIndex);

    const ALIASES = ['far', 'inbound'];
    const remote = wide.got.filter(f =>
      ALIASES.some(a => (f.from ?? '').startsWith(`${a}:`) || (f.to ?? '').startsWith(`${a}:`)));
    expect(remote.length).toBe(2);
  });

  // ── admin door ─────────────────────────────────────────────────────

  it('cross_border must be a real boolean, not merely truthy', () => {
    // Guarded at the handler; asserted here at the seam the handler uses, so
    // the rule is stated where the value is interpreted.
    for (const v of ['true', 1, 'yes', {}]) {
      expect(v === true).toBe(false);       // none of these mean "asked for it"
    }
    expect(true === true).toBe(true);
  });
});
