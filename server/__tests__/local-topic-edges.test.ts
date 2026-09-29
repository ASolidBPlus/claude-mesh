import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, aclGrant, getOrCreateTopic, subscribe, aclCheck, upsertPeer, getPeerByAlias } from '../db.ts';
import { routePublish, routeDirect, routeRelay, resetRelayBuckets } from '../router.ts';
import { hashToken } from '../auth.ts';
import { TOPIC_PRINCIPAL_PREFIX } from '../db.ts';

// A LOCAL topic post reaches a subscriber through the documented topic shape —
// poster → `topic:<t>` AND `topic:<t>` → subscriber — not only through a direct
// poster → subscriber edge. Before this, the topic shape alone wrote 0 rows,
// and the only workaround (a poster → subscriber edge) also opened DMs between
// the two. Additive: the legacy direct edge still delivers.

const T = 'ops.alerts';
const TOPIC = `${TOPIC_PRINCIPAL_PREFIX}${T}`;

let db: Database;
beforeEach(() => {
  db = openDb(':memory:');
  for (const id of ['poster', 'sub']) registerAgent(db, { id, token_hash: id.padEnd(64, 'x'), hostname: 'h' });
  getOrCreateTopic(db, T, 'poster');
  subscribe(db, 'sub', T);
});
afterEach(() => db.close());

/** Publish as `poster`; return the subscriber ids that got a stored copy. */
function publish(): string[] {
  const r = routePublish(db, new Map<string, WebSocket>(), 'poster',
    { type: 'publish', msg_id: crypto.randomUUID(), topic: T, payload: 'x' } as never,
    new Map<string, WebSocket>());
  expect(r.ok).toBe(true);
  return (db.prepare("SELECT to_agent FROM messages WHERE kind = 'topic' AND topic = ?").all(T) as { to_agent: string }[])
    .map(x => x.to_agent);
}

describe('local topic fan-out: the topic shape delivers, and does not open DMs', () => {
  it('(e) HEADLINE — topic edges alone do NOT allow a direct send from poster to subscriber', () => {
    aclGrant(db, 'poster', TOPIC, 'admin');
    aclGrant(db, TOPIC, 'sub', 'admin');
    // Positive control: the same edges DO carry the topic post (test a), so the
    // refusal below is about DMs, not about edges that grant nothing.
    expect(publish()).toEqual(['sub']);

    const dm = routeDirect(db, new Map<string, WebSocket>(), 'poster',
      { type: 'send', msg_id: crypto.randomUUID(), to: 'sub', payload: 'hi', content_type: 'text/plain' } as never);
    expect(dm.ok).toBe(false);
    expect(aclCheck(db, 'poster', 'sub')).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'direct'").get() as { n: number }).n).toBe(0);
  });

  it('(a) topic edges only (poster → topic, topic → sub): the subscriber receives it', () => {
    aclGrant(db, 'poster', TOPIC, 'admin');
    aclGrant(db, TOPIC, 'sub', 'admin');
    expect(publish()).toEqual(['sub']);
  });

  it('(b) poster → topic WITHOUT topic → sub: not received', () => {
    aclGrant(db, 'poster', TOPIC, 'admin');
    expect(publish()).toEqual([]);
  });

  it('(c) topic → sub WITHOUT poster → topic: not received', () => {
    aclGrant(db, TOPIC, 'sub', 'admin');
    expect(publish()).toEqual([]);
  });

  it('(d) the legacy direct edge (poster → sub) alone still delivers', () => {
    aclGrant(db, 'poster', 'sub', 'admin');
    expect(publish()).toEqual(['sub']);
  });

  it('no edges at all: not received', () => {
    expect(publish()).toEqual([]);
  });
});

describe('the OTHER fan-out callers are unchanged: only a local publish gains the topic shape', () => {
  // The spoke's delivery arm evaluates the ACL from the STAMPED remote topic
  // (`orch:trollbox`). If the topic shape applied there too, a local
  // `orch:trollbox` → `topic:orch:trollbox` → sub pair would start delivering
  // where it never did. This pins that it does not.
  //
  // The third caller — the hub re-originating a spoke's post — needs no test:
  // its principal already IS `topic:<t>`, so the topic shape would reduce to
  // the direct check it already makes.
  it('a spoke delivering an arriving topic frame still needs the direct hear edge', () => {
    resetRelayBuckets();
    registerAgent(db, { id: 'heard', token_hash: 'h'.padEnd(64, 'x'), hostname: 'h' });
    upsertPeer(db, { alias: 'orch', token_hash: hashToken('o'), minted_by_key: 'k', kinds: '["topic"]', rate_per_min: 600 });
    getOrCreateTopic(db, 'orch:trollbox', 'sub');
    subscribe(db, 'sub', 'orch:trollbox');
    subscribe(db, 'heard', 'orch:trollbox');
    aclGrant(db, 'orch:trollbox', 'heard', 'admin');                       // positive control: direct edge
    aclGrant(db, 'orch:trollbox', `${TOPIC_PRINCIPAL_PREFIX}orch:trollbox`, 'admin');
    aclGrant(db, `${TOPIC_PRINCIPAL_PREFIX}orch:trollbox`, 'sub', 'admin');   // the topic shape only

    const r = routeRelay(db, new Map<string, WebSocket>(), getPeerByAlias(db, 'orch')!, {
      type: 'relay', msg_id: `remote-${crypto.randomUUID()}`, kind: 'topic', from: 'trollbox', topic: 'trollbox',
      payload: 'hi', content_type: 'text/plain',
    } as never);
    expect(r.ok).toBe(true);
    const got = (db.prepare("SELECT to_agent FROM messages WHERE kind = 'topic' AND topic = 'orch:trollbox'").all() as { to_agent: string }[])
      .map(x => x.to_agent);
    expect(got).toEqual(['heard']);
  });
});
