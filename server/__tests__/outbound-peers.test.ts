import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  openDb, registerAgent, aclGrant, aclCheck, upsertPeer, getPeerByAlias,
  insertOutboundPeer, getOutboundPeer, listOutboundPeers, endOutboundPeering,
  countPendingMessages, hasOutboundPeer,
} from '../db.ts';
import { routeDirect, routeRelay, resetRelayBuckets } from '../router.ts';
import { startHttpAdmin, HttpAdminHandle, type ForwarderRegistry } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import type { WebSocket } from 'ws';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ADMIN = 'admin-secret';

function fakeSocket(): { sent: string[] } & WebSocket {
  const rec = { sent: [] as string[] };
  return { ...rec, send(d: string) { rec.sent.push(d); } } as unknown as { sent: string[] } & WebSocket;
}

// ════════════════════════════════════════════════════════════════════════════
// THE REQUIRED TEST (#106 finding 2) — first, because it is the guard that has
// been unexercisable since it was written.
// ════════════════════════════════════════════════════════════════════════════

describe('REQUIRED: routeRelay refuses a `to` containing ":" — and the mutant must DELIVER', () => {
  beforeEach(() => resetRelayBuckets());

  // WHY THE OBVIOUS TEST DOES NOT WORK, and why every earlier check below is
  // made to pass on purpose.
  //
  // The one-hop check on `to` is FIRST in routeRelay. A naive test using
  // `to = 'C:agent'` passes on shipped code — but with the check DROPPED the
  // frame falls through to the to-exists lookup, `getAgentById('C:agent')` is
  // null, and it is refused ANYWAY with the same RELAY_REFUSED bytes. The
  // mutant survives because a LATER check refuses identically.
  //
  // On a uniform-refusal endpoint, asserting "refused" proves nothing unless
  // every OTHER check has been made to PASS, so that only the check under test
  // can refuse. Enumerating what passes here:
  //
  //   validation      msg_id/from/to/payload non-empty strings, kind 'direct' ✓
  //   one-hop on FROM 'bob' has no colon ✓
  //   size            tiny payload ✓
  //   peer disabled   the peers row is enabled ✓
  //   rate bucket     reset in beforeEach, first relay of the window ✓
  //   kinds           peers.kinds is ["direct"] and kind is 'direct' ✓
  //   dedupe          fresh remote msg_id, empty relays table ✓
  //   TO-EXISTS       'legacy:node' IS a local agent — this is the mask being
  //                   lifted, and the reason the fixture needs a legacy id ✓
  //   inbound ACL     'othermesh:bob' → 'legacy:node' granted below ✓
  //
  // So the ONLY thing that can refuse is the one-hop rule on `to`. Drop it and
  // the relay is DELIVERED — which is what the mutant must show. A mutant that
  // merely produced a different refusal would still be masked.
  it('a legacy colon-id local recipient is still refused — only the one-hop rule can', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'legacy:node', token_hash: 'a'.repeat(64), hostname: 'h' });
    upsertPeer(db, {
      alias: 'othermesh', token_hash: 'c'.repeat(64), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(db, 'othermesh:bob', 'legacy:node', 'admin');

    const sock = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['legacy:node', sock]]);

    const r = routeRelay(db, agentIndex, getPeerByAlias(db, 'othermesh')!, {
      type: 'relay', msg_id: 'remote-1', kind: 'direct',
      from: 'bob', to: 'legacy:node', payload: 'transitive attempt',
    });

    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('RELAY_REFUSED');
    // The mutant DELIVERS. Nothing was sent and nothing was stored.
    expect(sock.sent.length).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('positive control: the SAME relay to a bare local id is delivered', () => {
    // Proves the fixture reaches delivery when the one-hop rule does not fire —
    // without it, the test above could pass because the relay path is broken.
    const db = openDb(':memory:');
    registerAgent(db, { id: 'node', token_hash: 'a'.repeat(64), hostname: 'h' });
    upsertPeer(db, {
      alias: 'othermesh', token_hash: 'c'.repeat(64), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(db, 'othermesh:bob', 'node', 'admin');

    const sock = fakeSocket();
    const r = routeRelay(db, new Map<string, WebSocket>([['node', sock]]), getPeerByAlias(db, 'othermesh')!, {
      type: 'relay', msg_id: 'remote-2', kind: 'direct',
      from: 'bob', to: 'node', payload: 'ordinary',
    });

    expect(r.ok).toBe(true);
    expect(sock.sent.length).toBe(1);
    db.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// routeDirect's remote branch
// ════════════════════════════════════════════════════════════════════════════

describe('F2a: routeDirect remote branch', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'local-b', token_hash: 'b'.repeat(64), hostname: 'h' });
  });
  afterEach(() => db.close());

  function peering(alias: string, kinds = '["direct"]'): void {
    insertOutboundPeer(db, {
      alias, url: 'ws://far.example:7300', token: 'SECRET-TOKEN-VALUE',
      assigned_alias: 'us', kinds, rate_per_min: 600, created_at: Date.now(),
    });
  }
  const send = (to: string, msg_id = 'm1', ttl_ms?: number) =>
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id, to, payload: 'p', content_type: 'text/plain',
      ...(ttl_ms !== undefined ? { ttl_ms } : {}),
    } as never);

  it('queues a remote message with the FQ recipient and acks the local sender', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');

    const r = send('far:them');
    expect(r.ok).toBe(true);

    const rows = db.prepare('SELECT to_agent, delivered_at FROM messages').all() as
      { to_agent: string; delivered_at: number | null }[];
    expect(rows.length).toBe(1);
    // The FQ id: the forwarder ranges on to_agent between 'far:' and 'far;'.
    expect(rows[0]!.to_agent).toBe('far:them');
    // Acked, NOT delivered — acceptance means queued for the border (D8).
    expect(rows[0]!.delivered_at).toBeNull();
  });

  // C9 SET TEST for this door: every cause of "may this go to that remote?"
  // answered identically, and identically to an unknown LOCAL id. A local
  // sender must not be able to map this mesh's peerings or ACL from outside.
  it('no peering / second colon / no edge / unknown local are byte-identical', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');

    const results = [
      send('nopeering:them', 'r1'),      // alias has no outbound peering
      send('far:a:b', 'r2'),             // second colon
      send('far:stranger', 'r3'),        // peered, but no edge
      send('no-such-local', 'r4'),       // ordinary unknown local id
    ];
    for (const r of results) expect(r.ok).toBe(false);
    const shapes = new Set(results.map(r => JSON.stringify({ ...r, error_message: '' })));
    expect(shapes.size).toBe(1);
    expect((results[0] as { error_code: string }).error_code).toBe('AGENT_NOT_FOUND');
  });

  // #123: the C9 SET TEST for a caller with NO EDGE. Before the fix,
  // KIND_NOT_ALLOWED was emitted BEFORE the ACL check, so an agent holding no
  // edge could enumerate which outbound peerings exist by sending a wrong-kind
  // message — and the error even named the alias. There is no other route to
  // that topology from inside the mesh.
  it('an EDGELESS caller cannot tell wrong-kind from no-peering from no-edge', () => {
    peering('far', '["file"]');          // exists, but 'direct' is not permitted
    // deliberately NO aclGrant for the sender

    const results = [
      send('far:them', 'k1'),            // peering exists, kind not permitted
      send('ghost:them', 'k2'),          // no peering at all
      send('far:other', 'k3'),           // peering exists, no edge
    ];
    // error_message echoes the caller's own `to`, which it supplied — not a
    // disclosure. The CODE is what must not vary.
    const shapes = new Set(results.map(r => JSON.stringify({ ...r, error_message: '' })));
    expect(shapes.size).toBe(1);
    expect((results[0] as { error_code: string }).error_code).toBe('AGENT_NOT_FOUND');
  });

  it('KIND_NOT_ALLOWED stays DISTINCT — own configuration, crosses no border', () => {
    // The deliberate exception, and the justification is REACHABILITY (#123):
    // only a caller that ALREADY HOLDS AN EDGE to this peering can reach this
    // refusal, and such a caller already knows the peering exists. The
    // exemption is about who can reach the message, never about what it says.
    //
    // This is also the positive control for the set test above — without it,
    // "all three identical" is satisfied by never emitting KIND_NOT_ALLOWED.
    peering('far', '["file"]');
    aclGrant(db, 'sender', 'far:them', 'admin');

    const r = send('far:them');
    expect(r.ok).toBe(false);
    expect((r as { error_code: string }).error_code).toBe('KIND_NOT_ALLOWED');
  });

  it('a LEGACY colon-id local agent still delivers locally', () => {
    // The fall-through must be unchanged: an alias with no outbound peering is
    // not remote, so `legacy:node` reaches the local lookup exactly as before.
    registerAgent(db, { id: 'legacy:node', token_hash: 'c'.repeat(64), hostname: 'h' });
    aclGrant(db, 'sender', 'legacy:node', 'admin');

    const sock = fakeSocket();
    const r = routeDirect(db, new Map<string, WebSocket>([['legacy:node', sock]]), 'sender', {
      type: 'send', msg_id: 'm-legacy', to: 'legacy:node', payload: 'p', content_type: 'text/plain',
    } as never);
    expect(r.ok).toBe(true);
    expect(sock.sent.length).toBe(1);
  });

  it('a reused msg_id on the remote branch is DUPLICATE_MSG_ID, never INTERNAL', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');
    expect(send('far:them', 'dup').ok).toBe(true);

    const again = send('far:them', 'dup');
    expect(again.ok).toBe(false);
    expect((again as { error_code: string }).error_code).toBe('DUPLICATE_MSG_ID');
  });

  it('two concurrent duplicates produce exactly ONE row', () => {
    // routeDirect is SYNCHRONOUS through the duplicate check and the insert. An
    // await between them lets both pass the check and the second insert throw.
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');

    const results = [send('far:them', 'race'), send('far:them', 'race')];
    expect(results.filter(r => r.ok).length).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
  });

  it('ttl_ms = 0 to a remote id is dropped, not queued', () => {
    // Same meaning as the local ephemeral path: deliver live or drop, never
    // queue. "Online" for a remote id is "the peering's socket is connected",
    // which only the forwarder knows — F2b relays it live.
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');

    const r = send('far:them', 'eph', 0);
    expect(r.ok).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// hasOutboundPeer, pinned at BOTH doors
// ════════════════════════════════════════════════════════════════════════════

describe('F2a: outbound peering gates aclGrant at both doors', () => {
  it('local → alias:x is refused without a peering and written with one', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });

    expect(() => aclGrant(db, 'sender', 'far:them', 'admin')).toThrow(/outbound peering/);

    insertOutboundPeer(db, {
      alias: 'far', url: 'ws://x:1', token: 'T', assigned_alias: 'us',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    expect(() => aclGrant(db, 'sender', 'far:them', 'admin')).not.toThrow();
    expect(aclCheck(db, 'sender', 'far:them')).toBe(true);
    db.close();
  });

  it('a DISABLED outbound peering is not a peering', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
    insertOutboundPeer(db, {
      alias: 'far', url: 'ws://x:1', token: 'T', assigned_alias: 'us',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    db.prepare('UPDATE outbound_peers SET enabled = 0').run();

    expect(hasOutboundPeer(db, 'far')).toBe(false);
    expect(() => aclGrant(db, 'sender', 'far:them', 'admin')).toThrow(/outbound peering/);
    db.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// endOutboundPeering
// ════════════════════════════════════════════════════════════════════════════

describe('F2a: endOutboundPeering — one transaction, three effects', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
    insertOutboundPeer(db, {
      alias: 'far', url: 'ws://x:1', token: 'T', assigned_alias: 'us',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    aclGrant(db, 'sender', 'far:them', 'admin');
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'queued-1', to: 'far:them', payload: 'p', content_type: 'text/plain',
    } as never);
  });
  afterEach(() => db.close());

  it('expires undelivered rows, removes outbound edges, and ends the peering', () => {
    expect(countPendingMessages(db)).toBe(1);

    const { expired, edges } = endOutboundPeering(db, 'far', 'test', { delete: true });

    expect(expired).toBe(1);
    expect(edges).toBe(1);
    expect(getOutboundPeer(db, 'far')).toBeNull();
    // THE POINT: this is the only moment anyone knows those rows are
    // undeliverable. A ttl-less row would otherwise wait forever for a
    // forwarder that is never coming back.
    expect(countPendingMessages(db)).toBe(0);
    expect(aclCheck(db, 'sender', 'far:them')).toBe(false);
  });

  it('a DELIVERED row is untouched — only undeliverable ones are expired', () => {
    db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?').run(Date.now(), 'queued-1');
    const { expired } = endOutboundPeering(db, 'far', 'test', { delete: true });
    expect(expired).toBe(0);
  });

  it('a BYSTANDER peering keeps its rows and edges', () => {
    insertOutboundPeer(db, {
      alias: 'other', url: 'ws://y:1', token: 'T2', assigned_alias: 'us',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    aclGrant(db, 'sender', 'other:them', 'admin');
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'queued-2', to: 'other:them', payload: 'p', content_type: 'text/plain',
    } as never);

    endOutboundPeering(db, 'far', 'test', { delete: true });

    expect(aclCheck(db, 'sender', 'other:them')).toBe(true);
    expect(countPendingMessages(db)).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The admin API. C9 does NOT bind this door — see the note in http-admin.ts:
// an admin can already enumerate everything, so specific refusals teach nothing
// and their diagnostic value is real. Every refusal below is distinct ON PURPOSE.
// ════════════════════════════════════════════════════════════════════════════

describe('F2a: POST /outbound-peers and the forwarder-factory refusal', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  let created: string[];
  let stopped: string[];

  async function start(registry: ForwarderRegistry): Promise<void> {
    db = openDb(':memory:');
    handle = await startHttpAdmin(
      0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f2a-')),
      new Map(), new Map(), new Map(), registry,
    );
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  }
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    db?.close();
  });

  const post = (body: unknown) =>
    fetch(`${base}/outbound-peers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const VALID = { alias: 'far', url: 'ws://far.example:7300', token: 'SECRET-TOKEN-VALUE', assigned_alias: 'us' };

  it('refuses 503 with NO row written when no forwarder factory is registered', async () => {
    // THE JOIN IN TIME. Between F2a and F2b merging, a peering created here
    // would accept sends, ack them (D8), and queue rows nothing can drain —
    // reached through a scheduling door rather than a code one. A refusal holds
    // regardless of merge order; a process rule holds only while someone
    // remembers it.
    await start({});                       // no `create` — F2b has not landed
    const res = await post(VALID);
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).error).toBe('no forwarder available');
    expect(listOutboundPeers(db).length).toBe(0);
  });

  it('positive control: with a stub factory it is created and the forwarder started', async () => {
    created = []; stopped = [];
    await start({ create: (row) => created.push(row.alias), stop: (a) => stopped.push(a) });
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(listOutboundPeers(db).length).toBe(1);
    // Event-driven, not polled: the handler that changed the state started it.
    expect(created).toEqual(['far']);
  });

  it('C7: the token never appears in any response body', async () => {
    created = [];
    await start({ create: (row) => created.push(row.alias) });
    await post(VALID);

    // Grep the BYTES of every read response, not a field list — a token leaking
    // under an unexpected key would pass a field-by-field check.
    const postBody = await (await post({ ...VALID, alias: 'far2' })).text();
    const getBody = await (await fetch(`${base}/outbound-peers`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();
    const patchBody = await (await fetch(`${base}/outbound-peers/far`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate_per_min: 30 }),
    })).text();

    for (const body of [postBody, getBody, patchBody]) {
      expect(body).not.toContain('SECRET-TOKEN-VALUE');
      expect(body).not.toContain('"token"');
    }
    // Positive control: the listing is not empty, so "does not contain" is not
    // satisfied by there being nothing to contain.
    expect(getBody).toContain('far');
  });

  it('refuses an alias that would SHADOW a legacy local id', async () => {
    created = [];
    await start({ create: (row) => created.push(row.alias) });
    registerAgent(db, { id: 'legacy:node', token_hash: 'a'.repeat(64), hostname: 'h' });

    const res = await post({ ...VALID, alias: 'legacy' });
    expect(res.status).toBe(400);
    // The population assertPeeringAllowed classifies as LOCAL must never become
    // addressable as remote — routeDirect's remote branch would otherwise
    // capture sends meant for that agent.
    expect((await res.json() as { error: string }).error).toContain('legacy:node');
    expect(listOutboundPeers(db).length).toBe(0);
  });

  it('refuses a bad url scheme, the reserved alias, and a duplicate — each distinctly', async () => {
    created = [];
    await start({ create: (row) => created.push(row.alias) });
    expect((await post({ ...VALID, url: 'http://far.example' })).status).toBe(400);
    expect((await post({ ...VALID, alias: 'mesh' })).status).toBe(400);
    expect((await post(VALID)).status).toBe(201);
    expect((await post(VALID)).status).toBe(409);

    // Distinct BY DESIGN on an admin door — the bodies differ, and that is the
    // decision recorded in http-admin.ts, not an oversight.
    const a = await (await post({ ...VALID, alias: 'x', url: 'http://y' })).text();
    const b = await (await post({ ...VALID, alias: 'mesh' })).text();
    expect(a).not.toBe(b);
  });
});

describe('F2a: DELETE ends a peering, PATCH pauses one', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  let stopped: string[];

  beforeEach(async () => {
    stopped = [];
    db = openDb(':memory:');
    handle = await startHttpAdmin(
      0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f2a-d-')),
      new Map(), new Map(), new Map(),
      { create: () => {}, stop: (a) => stopped.push(a) },
    );
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
    await fetch(`${base}/outbound-peers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'far', url: 'ws://far:1', token: 'T', assigned_alias: 'us' }),
    });
    aclGrant(db, 'sender', 'far:them', 'admin');
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'q1', to: 'far:them', payload: 'p', content_type: 'text/plain',
    } as never);
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('DELETE expires queued rows and removes edges, in one transaction', async () => {
    expect(countPendingMessages(db)).toBe(1);
    const res = await fetch(`${base}/outbound-peers/far`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
    expect(countPendingMessages(db)).toBe(0);
    expect(aclCheck(db, 'sender', 'far:them')).toBe(false);
    expect(stopped).toEqual(['far']);
  });

  it('PATCH {enabled:false} is REVERSIBLE — rows and edges survive', async () => {
    // Pausing and ending are different operations, not two spellings of one.
    const res = await fetch(`${base}/outbound-peers/far`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(getOutboundPeer(db, 'far')?.enabled).toBe(0);
    // The queued row is still deliverable when the peering comes back.
    expect(countPendingMessages(db)).toBe(1);
    expect(aclCheck(db, 'sender', 'far:them')).toBe(true);
  });

  it('PATCH {token} restarts the forwarder WITHOUT expiring rows', async () => {
    const res = await fetch(`${base}/outbound-peers/far`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'ROTATED-TOKEN' }),
    });
    expect(res.status).toBe(200);
    expect(getOutboundPeer(db, 'far')?.token).toBe('ROTATED-TOKEN');
    expect(countPendingMessages(db)).toBe(1);
    expect(stopped).toEqual(['far']);   // stopped, then recreated with the new credential
  });
});
