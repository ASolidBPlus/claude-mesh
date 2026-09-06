import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  openDb, registerAgent, aclGrant, getOrCreateTopic, subscribe, upsertPeer,
  getTopicSubscribers, getPeerByAlias,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { routePublish, routeRelay, resetRelayBuckets } from '../router.ts';
import type { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { Forwarder } from '../border.ts';
import { join } from 'path';

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

// ── commit 4: hub → spoke ────────────────────────────────────────────────────
//
// The hub owns the topic and is the ordering authority. It fans out locally and
// enqueues ONE row per PEERING — not per remote subscriber — because a peering
// carries one frame and the receiving mesh fans out with its own ACL. That is
// the whole economy of hub-and-spoke: N subscribers on a pod cost one border
// frame and one rate token, not N.

function fakeSocket(): { sent: string[] } & WebSocket {
  const rec = { sent: [] as string[] };
  return { ...rec, send(d: string) { rec.sent.push(d); } } as unknown as { sent: string[] } & WebSocket;
}

describe('F4 hub → spoke: one frame per peering', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'hub-pub', token_hash: hashToken('p'), hostname: 'h' });
    getOrCreateTopic(db, 'trollbox', 'hub-pub');
    for (const alias of ['pod1', 'pod2']) {
      upsertPeer(db, {
        alias, token_hash: hashToken(alias), minted_by_key: 'k',
        kinds: '["topic-publish","topic-subscribe"]', rate_per_min: 600,
      });
      db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                  VALUES (?, ?, 'tok', 'orch', '["topic"]', 600, ?)`).run(alias, `wss://${alias}.example`, Date.now());
    }
  });
  afterEach(() => { db.close(); });

  const borderRows = (alias: string) =>
    db.prepare("SELECT * FROM messages WHERE to_agent = ? AND kind = 'topic'").all(`${alias}:`) as {
      id: string; from_agent: string; topic: string; origin: string | null; payload: string;
    }[];

  const subscribeRemote = (id: string) => {
    subscribe(db, id, 'trollbox');
    aclGrant(db, 'topic:trollbox', id, 'admin');       // the RIGHT TO HEAR
  };

  it('three permitted subscribers on one pod cost exactly ONE outbound row', () => {
    subscribeRemote('pod1:a'); subscribeRemote('pod1:b'); subscribeRemote('pod1:c');
    expect(getTopicSubscribers(db, 'trollbox').length).toBe(3);   // POSITIVE CONTROL

    routePublish(db, new Map(), 'hub-pub', { type: 'publish', topic: 'trollbox', payload: 'hi' } as never);

    expect(borderRows('pod1').length).toBe(1);
  });

  it('two pods cost one row each, and a pod with no permitted subscriber costs none', () => {
    subscribeRemote('pod1:a');
    subscribe(db, 'pod2:b', 'trollbox');              // subscribed, but NO hear edge
    routePublish(db, new Map(), 'hub-pub', { type: 'publish', topic: 'trollbox', payload: 'hi' } as never);

    expect(borderRows('pod1').length).toBe(1);
    // The SENDER-side gate: without a RIGHT TO HEAR edge, nothing leaves at all.
    // Not "leaves and is filtered there" — the hub decides whether the topic may
    // reach that mesh.
    expect(borderRows('pod2').length).toBe(0);
  });

  // M2's control (plan §11): an alias with NO outbound peering must never
  // produce a row, however many subscription rows name it. This is what reds if
  // the enqueue is moved inside the local fan-out, where it would run per
  // subscriber and off the peering list.
  it('CONTROL: a subscription naming a mesh we do not peer with produces nothing', () => {
    // The row is inserted RAW because that is the only way it can exist:
    // `aclGrant` refuses `topic:trollbox → pod3:ghost` outright without an
    // outbound peering (measured — it throws NO_PEERING), so a pod3 row can
    // only be a stale one that outlived its peering. Which is exactly the case
    // worth pinning: the enqueue must read the PEERING LIST, not the
    // subscription rows.
    db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?,?,?)')
      .run('pod3:ghost', 'trollbox', Date.now());
    routePublish(db, new Map(), 'hub-pub', { type: 'publish', topic: 'trollbox', payload: 'hi' } as never);

    expect(borderRows('pod3').length).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM messages WHERE kind = 'topic'").get()).toEqual({ c: 0 });
  });

  it('the outbound row is addressed to the peering and FROM the topic principal', () => {
    subscribeRemote('pod1:a');
    routePublish(db, new Map(), 'hub-pub', { type: 'publish', topic: 'trollbox', payload: 'post' } as never);

    const [row] = borderRows('pod1');
    expect(row!.from_agent).toBe('topic:trollbox');
    expect(row!.topic).toBe('trollbox');
    expect(row!.payload).toBe('post');
    // The hub is the origin of its own post: the publisher's bare id.
    expect(row!.origin).toBe('hub-pub');
  });
});

describe('F4 spoke: an arriving topic frame', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'sub', token_hash: hashToken('s'), hostname: 'h' });
    registerAgent(db, { id: 'nosub', token_hash: hashToken('n'), hostname: 'h' });
    upsertPeer(db, {
      alias: 'orch', token_hash: hashToken('o'), minted_by_key: 'k',
      kinds: '["topic"]', rate_per_min: 600,
    });
    // The spoke holds a LOCAL topics row named for the remote topic; that is
    // what routeSubscribe creates, and why home-ness is a prefix test rather
    // than row existence.
    getOrCreateTopic(db, 'orch:trollbox', 'sub');
    subscribe(db, 'sub', 'orch:trollbox');
    subscribe(db, 'nosub', 'orch:trollbox');
    aclGrant(db, 'orch:trollbox', 'sub', 'admin');    // only `sub` may hear
  });
  afterEach(() => { db.close(); });

  const topicFrame = (over: Record<string, unknown> = {}) => ({
    type: 'relay' as const, msg_id: `remote-${Math.floor(Date.now() % 1e9)}-${over.msg_id ?? '1'}`,
    kind: 'topic', from: 'trollbox', topic: 'trollbox',
    payload: 'hi', content_type: 'text/plain', ...over,
  });

  // RECEIVER-SIDE ACL, ON THE TOPIC PRINCIPAL. The hub decided the topic may
  // reach this mesh; this mesh decides which of ITS agents hear it. Both gates
  // exist and neither substitutes for the other.
  it('fans out to the subscriber holding the hear edge, and not to the other', () => {
    const sock = fakeSocket();
    const r = routeRelay(db, new Map([['sub', sock]]), getPeerByAlias(db, 'orch')!, topicFrame() as never);
    expect(r.ok).toBe(true);

    const delivered = JSON.parse(sock.sent[0]!);
    expect(delivered.type).toBe('deliver');
    expect(delivered.kind).toBe('topic');
    // Stamped with OUR alias for them: a local agent can never be confused for
    // the remote topic.
    expect(delivered.from).toBe('orch:trollbox');
    expect(delivered.topic).toBe('orch:trollbox');

    const rows = db.prepare("SELECT to_agent FROM messages WHERE kind='topic'").all() as { to_agent: string }[];
    expect(rows.map(r2 => r2.to_agent)).toEqual(['sub']);
  });

  it('carries origin through to the row and the deliver frame, and changes nothing else', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['sub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: 'pod1:alice' }) as never);

    const delivered = JSON.parse(sock.sent[0]!);
    expect(delivered.origin).toBe('pod1:alice');
    // ...and it is NOT the sender: `from` is still the stamped topic.
    expect(delivered.from).toBe('orch:trollbox');
    const row = db.prepare("SELECT from_agent, origin FROM messages WHERE kind='topic'").get() as
      { from_agent: string; origin: string };
    expect(row.origin).toBe('pod1:alice');
    expect(row.from_agent).toBe('orch:trollbox');
  });

  // ORIGIN IS NOT AN ACL PRINCIPAL. A peer that forges an origin naming a local
  // agent must change no outcome — the refusal for `nosub` stands.
  it('a forged origin changes no ACL outcome', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['nosub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: 'orch:trollbox' }) as never);

    expect(sock.sent).toEqual([]);
    const rows = db.prepare("SELECT to_agent FROM messages WHERE kind='topic'").all() as { to_agent: string }[];
    expect(rows.map(r => r.to_agent)).toEqual(['sub']);   // queued for sub only
  });

  // A DELIVERY IS NEVER RE-ORIGINATED. Two borders maximum, and only through
  // the topic's home mesh: if an arriving `topic` frame produced outbound rows,
  // a two-pod topology would loop.
  it('produces no outbound border rows of its own', () => {
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('orch','wss://orch.example','tok','pod1','["topic"]',600,?)`).run(Date.now());
    subscribe(db, 'orch:someone', 'orch:trollbox');
    aclGrant(db, 'orch:trollbox', 'orch:someone', 'admin');

    routeRelay(db, new Map(), getPeerByAlias(db, 'orch')!, topicFrame() as never);

    const outbound = db.prepare("SELECT COUNT(*) c FROM messages WHERE to_agent LIKE '%:' AND kind='topic'").get();
    expect(outbound).toEqual({ c: 0 });
  });
});

// ── the structural guarantee (plan §15 note 1, mutant M2) ────────────────────
//
// `enqueueOutboundTopicRows` must have EXACTLY ONE call site. Two publish paths
// need it — a local agent publishing a home topic, and the hub re-originating a
// spoke's post — and both route through `fanOutHomeTopicPublish`, which is that
// one site. The reason is not tidiness: `fanOutTopicLocal` is ALSO called by the
// `topic` DELIVERY arm, so an enqueue placed inside it would make every arriving
// delivery re-originate, and a two-pod topology would loop.
//
// This is checked structurally because the behavioural test for it (the pod3
// control) can only see the case it drives, and a loop needs two peerings and a
// delivery to appear at all.
describe('F4 the enqueue has exactly one call site', () => {
  const source = () => {
    const src = readFileSync(join(import.meta.dir, '../router.ts'), 'utf8');
    // Comments are stripped: this function is DISCUSSED in several of them, and
    // a scan that counted prose would be measuring how much was written about
    // the rule rather than whether the code follows it.
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  };

  it('one definition, one call, and no mention that is neither', () => {
    const code = source();
    const defs = [...code.matchAll(/export\s+function\s+enqueueOutboundTopicRows\s*\(/g)];
    const calls = [...code.matchAll(/\benqueueOutboundTopicRows\s*\(/g)];
    expect(defs.length).toBe(1);
    expect(calls.length - defs.length).toBe(1);

    // No MENTION that is not a call — the alias route (`const e =
    // enqueueOutboundTopicRows; … e(m)`) adds a caller the count above cannot
    // see. Learned on #170, where exactly that hole survived three rounds.
    expect([...code.matchAll(/\benqueueOutboundTopicRows\b(?!\s*\()/g)].length).toBe(0);
  });

  it('the ONE call is inside fanOutHomeTopicPublish, not the local fan-out or the topic arm', () => {
    const code = source();
    const bodyOf = (name: string): string => {
      const start = code.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      // To the next top-level `function`/`export function`, which is where this
      // one ends — good enough for a single-file scan and stated as such.
      const next = code.slice(start + 1).search(/\n(?:export\s+)?function\s/);
      return code.slice(start, next === -1 ? undefined : start + 1 + next);
    };

    expect(bodyOf('fanOutHomeTopicPublish')).toContain('enqueueOutboundTopicRows(');
    // The two bodies that must NOT enqueue, named individually so a failure
    // says which one broke.
    expect(bodyOf('fanOutTopicLocal')).not.toContain('enqueueOutboundTopicRows(');
    expect(bodyOf('routeRelay')).not.toContain('enqueueOutboundTopicRows(');
  });
});

// ── the wire shape of a topic row (plan §7 border.ts) ────────────────────────
//
// The row's KIND decides the frame. This is driven through `Forwarder.send`
// with a recording client rather than asserted against a hand-built object,
// because the thing that can go wrong is the branch, not the shape: the direct
// arm slices `to_agent` for the remote id, and a topic row's `to_agent` is the
// bare peering (`pod1:`), so slicing it would put `to: ""` on a frame that must
// carry no `to` at all.
describe('F4 Forwarder.send branches on the row kind', () => {
  const peeringRow = {
    alias: 'pod1', url: 'ws://127.0.0.1:7300', token: 'T', assigned_alias: 'orch',
    kinds: '["topic"]', rate_per_min: 600, enabled: 1, created_at: 1, last_alive: null,
  };

  const sendRow = (row: Record<string, unknown>) => {
    const db = openDb(':memory:');
    const f = new Forwarder(db, peeringRow, new Map<string, WebSocket>());
    const sent: Record<string, unknown>[] = [];
    const probe = f as unknown as {
      client: { relay(frame: Record<string, unknown>): Promise<void> } | null;
      send(r: unknown, now: number): void;
    };
    // A promise that never settles: we want the FRAME, and resolving it would
    // run onSendAck against a database this helper is about to close. (It did,
    // on the first run: "Cannot use a closed database" from markDelivered.)
    probe.client = { relay: (frame) => { sent.push(frame); return new Promise<void>(() => {}); } };
    probe.send(row, 1_000);
    f.stop();
    db.close();
    return sent[0]!;
  };

  const base = {
    id: 'row-1', from_agent: 'topic:trollbox', to_agent: 'pod1:', topic: 'trollbox',
    payload: 'hi', content_type: 'text/plain', expires_at: 6_000, origin: null,
  };

  it('a topic row: from is the BARE topic, no `to`, origin omitted when null', () => {
    const frame = sendRow({ ...base, kind: 'topic' });
    expect(frame.kind).toBe('topic');
    expect(frame.from).toBe('trollbox');
    expect(frame.topic).toBe('trollbox');
    expect('to' in frame).toBe(false);
    expect('origin' in frame).toBe(false);
    expect(frame.payload).toBe('hi');
    expect(frame.msg_id).toBe('row-1');
  });

  it('origin rides when the row has one', () => {
    expect(sendRow({ ...base, kind: 'topic', origin: 'pod2:bob' }).origin).toBe('pod2:bob');
  });

  it('subscribe and unsubscribe carry no payload', () => {
    for (const kind of ['topic-subscribe', 'topic-unsubscribe']) {
      const frame = sendRow({ ...base, kind, from_agent: 'alice', payload: '' });
      expect({ kind, keys: 'payload' in frame }).toEqual({ kind, keys: false });
      expect(frame.from).toBe('alice');
      expect(frame.topic).toBe('trollbox');
      expect('to' in frame).toBe(false);
    }
  });

  it('a topic-publish carries the bare publisher and the payload', () => {
    const frame = sendRow({ ...base, kind: 'topic-publish', from_agent: 'alice' });
    expect(frame.from).toBe('alice');
    expect(frame.payload).toBe('hi');
    expect('to' in frame).toBe(false);
  });

  // CONTROL: the direct arm is unchanged, and it is the ONLY one that slices
  // the remote out of `to_agent`.
  it('CONTROL: a direct row still carries the sliced remote as `to`', () => {
    const frame = sendRow({ ...base, kind: 'direct', from_agent: 'alice', to_agent: 'pod1:bob', topic: null });
    expect(frame.kind).toBe('direct');
    expect(frame.to).toBe('bob');
    expect(frame.from).toBe('alice');
  });
});
