import { describe, it, expect, beforeEach } from 'bun:test';
import {
  openDb, registerAgent, upsertPeer, aclGrant, getPeerByAlias, sweepRelays, getMessage,
} from '../db.ts';
import { routeRelay, resetRelayBuckets } from '../router.ts';
import { renderMetrics } from '../metrics.ts';
import { RELAY_DEDUPE_MS } from '../cleanup.ts';
import type { WebSocket } from 'ws';

// F1b (§5.2) — the inbound relay.
//
// REFUSALS ARE UNIFORM by design: everything except the rate limit answers
// RELAY_REFUSED, so a peer learns that its frame was refused and nothing about
// why — not whether the recipient exists, not whether an edge exists, not
// whether the kind is permitted. Several tests below assert that the refusals
// are INDISTINGUISHABLE, which is the property, rather than asserting each
// reason separately, which would be the opposite of it.

function fakeSocket(): { sent: string[] } & WebSocket {
  const rec = { sent: [] as string[] };
  return { ...rec, send(d: string) { rec.sent.push(d); } } as unknown as { sent: string[] } & WebSocket;
}

function setup(opts: { kinds?: string; rate?: number } = {}) {
  const db = openDb(':memory:');
  registerAgent(db, { id: 'local-a', token_hash: 'a'.repeat(64), hostname: 'h' });
  registerAgent(db, { id: 'local-b', token_hash: 'b'.repeat(64), hostname: 'h' });
  upsertPeer(db, {
    alias: 'othermesh', token_hash: 'c'.repeat(64), minted_by_key: 'k',
    kinds: opts.kinds ?? '["direct"]', rate_per_min: opts.rate ?? 600,
  });
  // The inbound edge: their agent may reach ours.
  aclGrant(db, 'othermesh:their-agent', 'local-a', 'admin');
  return db;
}

const relayFrame = (over: Record<string, unknown> = {}) => ({
  type: 'relay' as const, msg_id: 'remote-1', kind: 'direct',
  from: 'their-agent', to: 'local-a', payload: 'hello', ...over,
});

describe('F1b: a relay with an inbound edge is delivered', () => {
  beforeEach(() => resetRelayBuckets());

  it('delivers to a connected agent, stamped alias:from', () => {
    const db = setup();
    const sock = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['local-a', sock]]);

    const r = routeRelay(db, agentIndex, getPeerByAlias(db, 'othermesh')!, relayFrame());
    expect(r.ok).toBe(true);

    const delivered = JSON.parse(sock.sent[0]!);
    expect(delivered.type).toBe('deliver');
    // The sender is namespaced by OUR alias for them — a local agent can never
    // produce this id, so it cannot be forged from inside.
    expect(delivered.from).toBe('othermesh:their-agent');
    expect(delivered.payload).toBe('hello');
    db.close();
  });

  it('queues for an OFFLINE agent and the row carries the stamped sender', () => {
    const db = setup();
    const r = routeRelay(db, new Map(), getPeerByAlias(db, 'othermesh')!, relayFrame());
    expect(r.ok).toBe(true);

    const rows = db.prepare('SELECT id, from_agent, to_agent FROM messages').all() as
      { id: string; from_agent: string; to_agent: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.from_agent).toBe('othermesh:their-agent');
    // A LOCAL id, not the remote one: the remote id lives in `relays` only,
    // because the peer's id space is theirs and could collide with ours.
    expect(rows[0]!.id).not.toBe('remote-1');
    expect(getMessage(db, 'remote-1')).toBeNull();
    db.close();
  });
});

describe('F1b: every non-rate refusal is indistinguishable', () => {
  beforeEach(() => resetRelayBuckets());

  it('unknown recipient, no edge, wrong kind and a ":" sender all answer the same', () => {
    const db = setup();
    const peer = getPeerByAlias(db, 'othermesh')!;
    const results = [
      routeRelay(db, new Map(), peer, relayFrame({ to: 'no-such-agent' })),
      routeRelay(db, new Map(), peer, relayFrame({ to: 'local-b' })),          // no edge
      routeRelay(db, new Map(), peer, relayFrame({ kind: 'topic' })),
      routeRelay(db, new Map(), peer, relayFrame({ from: 'third:agent' })),    // one-hop
      routeRelay(db, new Map(), peer, relayFrame({ to: 'other:agent' })),
    ];
    for (const r of results) expect(r.ok).toBe(false);
    // Byte-identical: a peer cannot use refusals to enumerate our agents or
    // discover which edges exist.
    const shapes = new Set(results.map(r => JSON.stringify(r)));
    expect(shapes.size).toBe(1);
    expect([...shapes][0]).toContain('RELAY_REFUSED');
    db.close();
  });

  it('positive control: with the edge and a permitted kind it is NOT refused', () => {
    // Without this, "all refusals identical" is satisfied by refusing
    // everything.
    const db = setup();
    expect(routeRelay(db, new Map(), getPeerByAlias(db, 'othermesh')!, relayFrame()).ok).toBe(true);
    db.close();
  });

  it('one hop only — a ":" in from is refused EVEN WHEN an edge exists for it', () => {
    // Transitive federation nobody agreed to: our admin's border decision
    // covers THIS peer, not that peer's peers.
    //
    // The edge is granted deliberately. Without it the relay is refused by ACL
    // anyway, so the test cannot tell the one-hop rule from the edge check —
    // verified: the mutant that deletes the ':' check SURVIVED the version of
    // this test that omitted the grant. `othermesh:third:agent` is grantable
    // (its alias prefix is a real peering), which is exactly why the rule has
    // to be enforced at the relay rather than assumed from the ACL.
    const db = setup();
    aclGrant(db, 'othermesh:third:agent', 'local-a', 'admin');
    const sock = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['local-a', sock]]);

    const r = routeRelay(db, agentIndex, getPeerByAlias(db, 'othermesh')!, relayFrame({ from: 'third:agent' }));
    expect(r.ok).toBe(false);
    expect(sock.sent.length).toBe(0);
    db.close();
  });

  // THIS TEST IS THE MASKED FORM, and is kept deliberately — read the next
  // paragraph before treating it as the one-hop rule's pin.
  //
  // It asserts the CONTRACT ("a ':' in `to` is refused"), which is true and
  // worth holding. It does NOT pin the RULE: with the one-hop check deleted,
  // `third:b` is refused anyway by the later to-exists lookup, with identical
  // bytes, so the mutant SURVIVES here.
  //
  // The pin that admits under mutation is outbound-peers.test.ts (the REQUIRED
  // test, #106 finding 2): it uses a LEGACY colon-id LOCAL agent so to-exists
  // passes, making the one-hop rule the only thing that can refuse. Change the
  // rule and that test delivers; this one stays green.
  it('one hop only — a ":" in to is refused (contract, not the rule — see comment)', () => {
    const db = setup();
    expect(routeRelay(db, new Map(), getPeerByAlias(db, 'othermesh')!, relayFrame({ to: 'third:b' })).ok).toBe(false);
    db.close();
  });
});

describe('F1b: dedupe on the remote id', () => {
  beforeEach(() => resetRelayBuckets());

  it('the same relay twice is acked twice and delivered once', () => {
    const db = setup();
    const sock = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['local-a', sock]]);
    const peer = getPeerByAlias(db, 'othermesh')!;

    expect(routeRelay(db, agentIndex, peer, relayFrame()).ok).toBe(true);
    expect(routeRelay(db, agentIndex, peer, relayFrame()).ok).toBe(true);

    // Two acks (both ok), ONE delivery: a peer's retry after a lost ack must be
    // safe, which is the whole reason the ledger exists.
    expect(sock.sent.length).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('after the dedupe window is swept, the same id is a NEW message', () => {
    // By design, and stated: the alternative is a ledger that grows forever.
    const db = setup();
    const peer = getPeerByAlias(db, 'othermesh')!;
    expect(routeRelay(db, new Map(), peer, relayFrame()).ok).toBe(true);

    // Age the ledger row past the window, then sweep it exactly as cleanup does.
    db.prepare('UPDATE relays SET seen_at = ?').run(Date.now() - RELAY_DEDUPE_MS - 1000);
    expect(sweepRelays(db, RELAY_DEDUPE_MS)).toBe(1);

    expect(routeRelay(db, new Map(), peer, relayFrame()).ok).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(2);
    db.close();
  });
});

describe('F1b: the rate bucket', () => {
  beforeEach(() => resetRelayBuckets());

  it('refuses the (N+1)th relay in a minute with a DISTINGUISHABLE code', () => {
    // RATE_LIMITED is deliberately not RELAY_REFUSED: it is the one refusal a
    // well-behaved peer can act on.
    const db = setup({ rate: 3 });
    const peer = getPeerByAlias(db, 'othermesh')!;
    for (let i = 0; i < 3; i++) {
      expect(routeRelay(db, new Map(), peer, relayFrame({ msg_id: `m${i}` })).ok).toBe(true);
    }
    const over = routeRelay(db, new Map(), peer, relayFrame({ msg_id: 'm3' }));
    expect(over.ok).toBe(false);
    expect((over as { code: string }).code).toBe('RATE_LIMITED');
    expect((over as { ref?: string }).ref).toBe('m3');
    db.close();
  });

  it('REFUSED relays count against the rate too', () => {
    // Otherwise a peer probes the mesh for free by sending frames it knows
    // will fail — unlimited enumeration attempts at no cost.
    const db = setup({ rate: 2 });
    const peer = getPeerByAlias(db, 'othermesh')!;
    expect(routeRelay(db, new Map(), peer, relayFrame({ to: 'ghost', msg_id: 'x1' })).ok).toBe(false);
    expect(routeRelay(db, new Map(), peer, relayFrame({ to: 'ghost', msg_id: 'x2' })).ok).toBe(false);

    const third = routeRelay(db, new Map(), peer, relayFrame({ msg_id: 'x3' }));
    expect((third as { code: string }).code).toBe('RATE_LIMITED');
    db.close();
  });
});

describe('F1b: a disabled peer relays nothing', () => {
  beforeEach(() => resetRelayBuckets());

  it('refuses with the SAME bytes as a no-edge refusal, and does not close', () => {
    // The window before the sweep closes the socket, or before a revoke-close
    // lands. Compared against another PEER-REACHABLE refusal (#104's lesson:
    // an equality test needs its subjects justified — comparing against an
    // agent-path refusal would prove nothing about what a peer can observe).
    const db = setup();
    const sock = fakeSocket();
    const live = getPeerByAlias(db, 'othermesh')!;
    const noEdge = routeRelay(db, new Map([['local-a', sock]]), live, relayFrame({ to: 'local-b' }));

    db.prepare('UPDATE peers SET disabled = 1 WHERE alias = ?').run('othermesh');
    const disabled = routeRelay(db, new Map([['local-a', sock]]), getPeerByAlias(db, 'othermesh')!, relayFrame());

    expect(disabled.ok).toBe(false);
    expect(JSON.stringify(disabled)).toBe(JSON.stringify({ ...noEdge, ref: 'remote-1' }));
    // Nothing delivered, and the relay path does not close the socket —
    // closing belongs to the sweep and the revoke path.
    expect(sock.sent.length).toBe(0);
    db.close();
  });
});

describe('F1b: metrics are labelled per ALIAS, never per remote agent', () => {
  beforeEach(() => resetRelayBuckets());

  it('counts by alias/direction/outcome and carries no remote agent id', () => {
    // A remote mesh chooses its own agent ids, so a per-agent label lets a peer
    // mint unbounded label values in our metrics store.
    const db = setup();
    const peer = getPeerByAlias(db, 'othermesh')!;
    routeRelay(db, new Map(), peer, relayFrame({ msg_id: 'ok-1' }));
    routeRelay(db, new Map(), peer, relayFrame({ msg_id: 'bad-1', to: 'ghost' }));

    // Per-alias labels are OPT-IN since the /metrics topology finding: the
    // aliases themselves are the disclosure on an unauthenticated endpoint.
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
    const out = renderMetrics(db);
    delete process.env.MESH_METRICS_IDENTITY_LABELS;
    expect(out).toContain('mesh_peer_relays_total{alias="othermesh",direction="in",outcome="delivered"} 1');
    expect(out).toContain('mesh_peer_relays_total{alias="othermesh",direction="in",outcome="refused"} 1');
    // The remote AGENT id must not appear even with labels on — cardinality we
    // do not control, and a different disclosure from the alias.
    expect(out).not.toContain('their-agent');
    db.close();
  });
});

describe('F1b: the peering rule lives in the chokepoint, both doors map it', () => {
  it('aclGrant refuses alias:x -> local with no peering, and allows it with one', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'local-a', token_hash: 'a'.repeat(64), hostname: 'h' });

    // No peers row: the alias names no peering we have agreed to.
    expect(() => aclGrant(db, 'nopeer:someone', 'local-a', 'admin')).toThrow(/inbound peering/);

    upsertPeer(db, {
      alias: 'nopeer', token_hash: 'z'.repeat(64), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    expect(() => aclGrant(db, 'nopeer:someone', 'local-a', 'admin')).not.toThrow();
    db.close();
  });

  it('a LEGACY colon-id local agent takes the LOCAL path, both directions', () => {
    // F0b preserves ids containing ':' that already existed — they are reported
    // at boot, never rejected, precisely because they exist. So ':' alone
    // cannot decide remoteness: it is true for ids created since F0b and FALSE
    // for the population F0b deliberately kept.
    //
    // Grammar-only refused NO_PEERING for two ORDINARY LOCAL AGENTS.
    const db = openDb(':memory:');
    registerAgent(db, { id: 'local-a', token_hash: 'a'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'legacy:node', token_hash: 'b'.repeat(64), hostname: 'h' });

    expect(() => aclGrant(db, 'local-a', 'legacy:node', 'admin')).not.toThrow();
    expect(() => aclGrant(db, 'legacy:node', 'local-a', 'admin')).not.toThrow();
    db.close();
  });

  it('positive control: a colon id that is NOT a local agent is still remote', () => {
    // Without this, the fix is satisfied by dropping the peering rule entirely.
    const db = openDb(':memory:');
    registerAgent(db, { id: 'local-a', token_hash: 'a'.repeat(64), hostname: 'h' });
    expect(() => aclGrant(db, 'nopeer:someone', 'local-a', 'admin')).toThrow(/inbound peering/);

    upsertPeer(db, {
      alias: 'nopeer', token_hash: 'z'.repeat(64), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    expect(() => aclGrant(db, 'nopeer:someone', 'local-a', 'admin')).not.toThrow();
    db.close();
  });

  it('a DISABLED peer is not a peering', () => {
    const db = setup();
    db.prepare('UPDATE peers SET disabled = 1 WHERE alias = ?').run('othermesh');
    expect(() => aclGrant(db, 'othermesh:other', 'local-b', 'admin')).toThrow(/inbound peering/);
    db.close();
  });

  it('local -> alias:x is refused: there is no outbound peering yet (F2)', () => {
    // hasOutboundPeer returns false until outbound_peers exists. Refusing is
    // the honest answer; a permissive default would let an admin create an
    // edge the bus cannot honour.
    const db = setup();
    expect(() => aclGrant(db, 'local-a', 'othermesh:their-agent', 'admin')).toThrow(/outbound peering/);
    db.close();
  });
});
