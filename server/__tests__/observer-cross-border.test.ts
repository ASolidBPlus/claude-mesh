import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import {
  openDb, registerAgent, aclGrant, grantObserver, listObservers, listCrossBorderObservers,
  insertOutboundPeer, upsertPeer, getPeerByAlias,
} from '../db.ts';
import { routeDirect, routeRelay, routePublish, routeFile } from '../router.ts';
import { emitTap, LOCAL_ONLY, type TapFrame } from '../tap.ts';
import { startHttpAdmin } from '../http-admin.ts';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';

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

  // The functions the drive below calls. Named once, asserted against the code
  // by the scan test, and used by both the SET test and its CONTROL so the two
  // can never drift apart.
  const DRIVEN = ['routeDirect', 'routeRelay', 'routePublish', 'routeFile'];

  // Sets up peers/ACL and drives every emitting route. Returns nothing: the
  // tests read what the observer RECEIVED, never what this returned.
  function driveEveryEmittingRoute(observerIndex: Map<string, WebSocket>): void {
    insertOutboundPeer(db, { alias: 'far', url: 'wss://far.example/ws', token: 't'.repeat(32), assigned_alias: 'us', kinds: '["direct"]', rate_per_min: 600, created_at: Date.now() });
    upsertPeer(db, { alias: 'inbound', token_hash: 'e'.repeat(64), minted_by_key: 'k', kinds: '["direct"]', rate_per_min: 600 });
    aclGrant(db, 'local-a', 'far:remote-b', 'system');
    aclGrant(db, 'inbound:remote-c', 'local-b', 'system');

    const agentIndex = new Map<string, WebSocket>();
    const filesDir = mkdtempSync(join(tmpdir(), 'mesh-f3-files-'));

    routeDirect(db, agentIndex, 'local-a', { type: 'send', msg_id: 'd1', to: 'local-b', payload: 'local' } as never, observerIndex);
    routeDirect(db, agentIndex, 'local-a', { type: 'send', msg_id: 'd2', to: 'far:remote-b', payload: 'outbound' } as never, observerIndex);
    routeRelay(db, agentIndex, getPeerByAlias(db, 'inbound')!, { type: 'relay', msg_id: 'r1', from: 'remote-c', to: 'local-b', kind: 'direct', payload: 'inbound', sent_at: Date.now(), ttl_ms: 60_000 } as never, observerIndex);
    routePublish(db, agentIndex, 'local-a', { type: 'publish', msg_id: 'p1', topic: 'general', payload: 'topic' } as never, observerIndex);
    // routeFile — the site the first version of this test did NOT drive, which
    // made the whole assertion vacuous for that path (seat 2's finding).
    routeFile(db, agentIndex, 'local-a', {
      type: 'file_send', msg_id: 'f1', to: 'local-b',
      filename: 'x.txt', content_type: 'text/plain',
      data: Buffer.from('hello').toString('base64'),
    } as never, 10_485_760, filesDir, observerIndex);
  }

  // THE SCAN. The drive list above IS an enumeration — the type makes an
  // unstated audience uncompilable, but nothing stops the drive list going
  // stale. This derives the truth from the code: every function in router.ts
  // containing an `emitTap(` call must be one this file drives.
  //
  // A COUNT would not do. A count reds when a site is ADDED and stays quiet
  // when one is MOVED from a driven function into an undriven one — which
  // loses coverage silently and is the same magnitude. Scanning for the SET of
  // names reds on add, on move, and on rename.
  it('SCAN: the drive list equals the set of router functions that emit a tap', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'router.ts'), 'utf8').split('\n');
    const emitting = new Set<string>();
    let current = '';
    for (const line of src) {
      // ALL THREE DECLARATION FORMS. The first version of this scan matched
      // only `function name(`, so an `async function` or a `const x = () =>`
      // route added AMONG the driven ones attributed its emitTap to the
      // PREVIOUS matched name and the scan stayed green with a new undriven
      // emitting route. Measured: placed where the preceding declaration is a
      // DRIVEN name, such a route was completely silent at 11 pass, 0 fail.
      //
      // Nothing in this repo enforces declaration style — there is no linter
      // config of any kind — so "we always write `export function`" is a habit,
      // and a habit is not something a guard may assume.
      const fn = line.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*[(<]/)
             ?? line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function|\()/);
      if (fn !== null) current = fn[1]!;
      if (line.includes('emitTap(') && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
        // An emitTap before ANY declaration match means the scan does not know
        // whose call this is — silently skipping it is how a call site
        // disappears from the set. Fail loudly instead.
        if (current === '') {
          throw new Error('SCAN: found an emitTap( call before any recognised declaration in router.ts — the scan cannot attribute it, so the drive list cannot be checked. Widen the declaration patterns rather than ignoring the call.');
        }
        emitting.add(current);
      }
    }
    expect(emitting.size).toBeGreaterThan(0);              // the scan found something
    expect([...emitting].sort()).toEqual([...DRIVEN].sort());
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
    const narrow = fakeSocket();
    grantObserver(db, 'watcher', 'system');                 // narrow, on purpose
    const observerIndex = new Map<string, WebSocket>([['watcher', narrow.ws]]);

    driveEveryEmittingRoute(observerIndex);

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
    const wide = fakeSocket();
    grantObserver(db, 'wide-watcher', 'system', true);
    const observerIndex = new Map<string, WebSocket>([['wide-watcher', wide.ws]]);

    driveEveryEmittingRoute(observerIndex);

    const ALIASES = ['far', 'inbound'];
    const remote = wide.got.filter(f =>
      ALIASES.some(a => (f.from ?? '').startsWith(`${a}:`) || (f.to ?? '').startsWith(`${a}:`)));
    // Counted, not merely non-empty: this is what makes the SET test's empty
    // result meaningful rather than vacuous, and it is what caught the relay
    // arm silently refusing when this file was first written.
    expect(remote.length).toBe(2);
    // And the local paths did arrive, so a narrow observer's empty leak-list
    // above is not the result of nothing being driven at all.
    expect(wide.got.length).toBeGreaterThan(2);
  });

  // ── admin door ─────────────────────────────────────────────────────

  // Drives the REAL admin door. The test this replaces was
  // `for (const v of ['true', 1, 'yes', {}]) expect(v === true).toBe(false)` —
  // an assertion about JavaScript's `===` that invoked no handler, could not
  // fail, and could not fail when the guard was deleted. Its comment claimed it
  // asserted "at the seam the handler uses" while using no seam. A guard whose
  // only test is a tautology is a guard protected by nothing.
  //
  // Note WHAT is asserted: the 400 AND the state. A status code alone passes
  // against a handler that 400s and grants anyway, and the thing that matters
  // here is whether a wide observer exists afterwards.
  it('the admin door refuses a non-boolean cross_border AND grants nothing', async () => {
    const admin = 'admin-token-for-tests';
    const handle = await startHttpAdmin(
      0, db, admin, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f3-')),
      new Map(), new Map(), new Map(),
    );
    const base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${base}/observers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    try {
      // Every value that is truthy-but-not-true. The `!!body.cross_border`
      // mutant ADMITS all of these — it grants a wide observer — so the state
      // assertion below is what catches it, not the status.
      for (const v of ['true', 1, 'yes', {}, [], 'false']) {
        const res = await post({ agent_id: 'watcher', cross_border: v });
        expect(res.status).toBe(400);
        expect(listCrossBorderObservers(db).has('watcher')).toBe(false);
      }

      // Absent field = narrow grant, and a pre-F3 client sends exactly this.
      const bare = await post({ agent_id: 'watcher' });
      expect(bare.status).toBe(201);
      expect(listCrossBorderObservers(db).has('watcher')).toBe(false);

      // POSITIVE CONTROL: without this, a handler that 400s on everything and
      // never grants would pass every assertion above.
      const real = await post({ agent_id: 'wide-watcher', cross_border: true });
      expect(real.status).toBe(201);
      expect(listCrossBorderObservers(db).has('wide-watcher')).toBe(true);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  });
});
