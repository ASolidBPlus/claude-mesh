import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  openDb, registerAgent, aclGrant, getOrCreateTopic, subscribe, upsertPeer,
  getTopicSubscribers, getPeerByAlias, insertPeerKey, revokePeerKey, aclCheck,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { routePublish, routeRelay, routeSubscribe, routeUnsubscribe, resetRelayBuckets } from '../router.ts';
import { MAX_TTL_MS } from '../router.ts';
import type { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { definitions, callSites, nonCallMentions, bodyOf } from './helpers/source-scan.ts';
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

  // ORIGIN IS STAMPED WITH THE ALIAS IT ARRIVED THROUGH, exactly as `from` is.
  // Raw, the string is ambiguous here: `alice` would read as a LOCAL agent and
  // `pod1:alice` names a mesh whose alias is pod1's business, not ours.
  it('stamps origin with the delivering alias, and changes nothing else', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['sub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: 'pod1:alice' }) as never);

    const delivered = JSON.parse(sock.sent[0]!);
    // Two colons: the post came to us through orch, from pod1's alice. It is
    // DELIBERATELY unroutable — we do not peer with pod1 and must not offer a
    // path back to it.
    expect(delivered.origin).toBe('orch:pod1:alice');
    // ...and it is NOT the sender: `from` is still the stamped topic.
    expect(delivered.from).toBe('orch:trollbox');
    const row = db.prepare("SELECT from_agent, origin FROM messages WHERE kind='topic'").get() as
      { from_agent: string; origin: string };
    expect(row.origin).toBe('orch:pod1:alice');
    expect(row.from_agent).toBe('orch:trollbox');
  });

  // The hub's OWN publisher arrives bare and becomes a real remote id — the
  // form a reader can actually make sense of.
  it('a bare origin becomes a remote id under our alias for them', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['sub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: 'hub-pub' }) as never);
    expect(JSON.parse(sock.sent[0]!).origin).toBe('orch:hub-pub');
  });

  // A PEER CANNOT FORGE A REPLYABLE FORM. Whatever it sends acquires our alias
  // as a prefix, and the alias is ours to choose — so an origin claiming to be
  // a local agent arrives as `orch:sub`, which names the peer's namespace and
  // not ours.
  it('a forged local-looking origin is stamped into the peer\'s namespace', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['sub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: 'sub' }) as never);
    expect(JSON.parse(sock.sent[0]!).origin).toBe('orch:sub');
  });

  // AN EMPTY ORIGIN IS ABSENT, NOT A VALUE (seat 2). `''` is a string, so it
  // would have stamped to `orch:` — a bare alias with a trailing colon, naming
  // nobody, which reads as a malformed remote id rather than as "no
  // provenance". Collapsing it to null keeps one shape for "we do not know"
  // instead of inventing a second.
  it('an EMPTY origin is treated as absent, not stamped into a bare alias', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['sub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: '' }) as never);

    const delivered = JSON.parse(sock.sent[0]!);
    expect(delivered.origin).toBe(null);
    expect(delivered.origin).not.toBe('orch:');
    const row = db.prepare("SELECT origin FROM messages WHERE kind='topic'").get() as { origin: string | null };
    expect(row.origin).toBe(null);
  });

  // The bound is checked AFTER stamping, because the stamp is what goes on the
  // wire. A 252-byte origin under a 5-byte prefix is 257 stamped.
  it('an origin that only exceeds 256 bytes ONCE STAMPED is refused', () => {
    expect(routeRelay(db, new Map(), getPeerByAlias(db, 'orch')!,
      topicFrame({ msg_id: 'u', origin: 'x'.repeat(250) }) as never).ok).toBe(true);
    expect(routeRelay(db, new Map(), getPeerByAlias(db, 'orch')!,
      topicFrame({ msg_id: 'o', origin: 'x'.repeat(252) }) as never).ok).toBe(false);
  });

  // ORIGIN IS NOT AN ACL PRINCIPAL. A peer that forges an origin naming a local
  // agent must change no outcome — the refusal for `nosub` stands.
  it('a forged origin changes no ACL outcome', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['nosub', sock]]), getPeerByAlias(db, 'orch')!,
      topicFrame({ origin: 'orch:trollbox' }) as never);   // arrives stamped as orch:orch:trollbox

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
  // The scanner is shared and PINNED (#173, server/__tests__/helpers/
  // source-scan.ts). The hand-rolled version this replaces stripped comments
  // with a regex that would eat a line containing a `//` inside a string, and
  // sliced a function body to the next column-0 `function` — which truncates
  // inside a template literal, making every absence check below pass because
  // the text was never read.
  const source = () => readFileSync(join(import.meta.dir, '../router.ts'), 'utf8');
  const NAME = 'enqueueOutboundTopicRows';

  it('one definition, one call, and no mention that is neither', () => {
    const src = source();
    expect(definitions(src, NAME)).toBe(1);
    expect(callSites(src, NAME)).toBe(1);
    // No MENTION that is not a call — the alias route (`const e =
    // enqueueOutboundTopicRows; … e(m)`) adds a caller the count above cannot
    // see. Learned on #170, where exactly that hole survived three rounds.
    expect(nonCallMentions(src, NAME)).toBe(0);
  });

  it('the ONE call is inside fanOutHomeTopicPublish, not the local fan-out or the topic arm', () => {
    const src = source();
    expect(bodyOf(src, 'fanOutHomeTopicPublish')).toContain(`${NAME}(`);
    // The two bodies that must NOT enqueue, named individually so a failure
    // says which one broke. `bodyOf` brace-matches and THROWS on an unbalanced
    // body, so a truncated slice cannot answer these quietly.
    expect(bodyOf(src, 'fanOutTopicLocal')).not.toContain(`${NAME}(`);
    expect(bodyOf(src, 'routeRelay')).not.toContain(`${NAME}(`);
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

// ── commit 5: spoke → hub, subscribe and unsubscribe ─────────────────────────

describe('F4 routeSubscribe: the remote branch and its uniform refusal', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'alice', token_hash: hashToken('a'), hostname: 'h' });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('orch','wss://orch.example','tok','pod1','["topic","topic-subscribe"]',600,?)`).run(Date.now());
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('nokind','wss://n.example','tok','pod1','["direct"]',600,?)`).run(Date.now());
  });
  afterEach(() => { db.close(); });

  const sub = (topic: string) => routeSubscribe(db, 'alice', { type: 'subscribe', topic } as never);
  const borderRows = () =>
    db.prepare("SELECT * FROM messages WHERE kind = 'topic-subscribe'").all() as
      { to_agent: string; from_agent: string; topic: string; expires_at: number }[];

  it('subscribing to a remote topic enqueues ONE border row and creates the local topic', () => {
    expect(sub('orch:trollbox').ok).toBe(true);

    const rows = borderRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.to_agent).toBe('orch:');       // the peering, not an agent
    expect(rows[0]!.from_agent).toBe('alice');     // bare — the hub stamps it
    expect(rows[0]!.topic).toBe('trollbox');       // bare — one hop

    // The local topics row is what the subscription points at, and it carries
    // the FULL remote name, which is why home-ness is a prefix test.
    expect(getTopicSubscribers(db, 'orch:trollbox')).toEqual(['alice']);
  });

  // THE SDK REPLAYS EVERY SUBSCRIPTION ON RECONNECT (client.ts, the replay loop
  // after auth). Without the `changes === 1` gate, every reconnect burns a
  // token from the peering's rate bucket to tell the hub something it already
  // knows — and a flapping spoke would rate-limit its own direct traffic.
  it('a replayed subscribe enqueues NO second row', () => {
    sub('orch:trollbox');
    expect(borderRows().length).toBe(1);
    sub('orch:trollbox');
    sub('orch:trollbox');
    expect(borderRows().length).toBe(1);
  });

  // §4: subscription state is not time-sensitive traffic. It must survive a
  // peering outage, so it gets the dedupe window rather than the 5-minute
  // default a message would take.
  it('the border row expires on the DEDUPE window, not the message default', () => {
    const before = Date.now();
    sub('orch:trollbox');
    const ttl = borderRows()[0]!.expires_at - before;
    expect(ttl).toBeGreaterThan(300_000);          // not the message default
    expect(ttl).toBeLessThanOrEqual(MAX_TTL_MS + 50);
  });

  // §6 — EVERY reachable refusal cause answers the SAME bytes. Asserted as a
  // SET, byte for byte, because that is the property; asserting each cause
  // separately would be the opposite of it. `routeSubscribe` emits no
  // KIND_NOT_ALLOWED: it has no ACL gate in front of it, so a distinct code
  // there would be a free topology oracle for any authenticated agent.
  it('every refusal cause is byte-identical', () => {
    const causes: [string, string][] = [
      ['no peering for the prefix', 'ghost:trollbox'],
      ['peering lacks topic-subscribe', 'nokind:trollbox'],
      ['empty remainder', 'orch:'],
      ['a second colon', 'orch:a:b'],
      ['over 256 bytes', `orch:${'x'.repeat(300)}`],
    ];
    // THE PROPERTY IS THAT THE ANSWER IS A PURE FUNCTION OF THE INPUT, not that
    // five different inputs produce identical bytes — they cannot, because the
    // message echoes what the caller asked for, and echoing the caller's own
    // string tells it nothing it did not already know. My first version
    // asserted the impossible version and failed 5 ≠ 1; the distinction is the
    // whole point of a uniform-refusal test, so it is written out rather than
    // quietly narrowed.
    for (const [label, topic] of causes) {
      expect({ label, answer: sub(topic) }).toEqual({
        label,
        answer: { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown topic: ${topic}` },
      });
    }

    // AND THE SAME INPUT, TWO DIFFERENT CAUSES, byte for byte. This is the
    // comparison that can actually detect a cause leaking: `orch:` is an empty
    // remainder while the peering exists, and an unpeered prefix once it is
    // gone.
    const withPeering = JSON.stringify(sub('orch:'));
    db.prepare("DELETE FROM outbound_peers WHERE alias = 'orch'").run();
    const withoutPeering = JSON.stringify(sub('orch:'));
    expect(withoutPeering).toBe(withPeering);

    // Nothing was written by any of them.
    expect(borderRows().length).toBe(0);
    expect(db.prepare('SELECT COUNT(*) c FROM subscriptions').get()).toEqual({ c: 0 });
  });

  it('CONTROL: an ordinary LOCAL subscribe still works and enqueues nothing', () => {
    expect(sub('trollbox').ok).toBe(true);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual(['alice']);
    expect(borderRows().length).toBe(0);
  });

  it('a NEW local topic name with a colon and no peering is refused', () => {
    // Not a remote address (no such peering) and not a permissible local name.
    expect(sub('ghost:x').ok).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM topics').get()).toEqual({ c: 0 });
  });
});

describe('F4 routeUnsubscribe: teardown is always allowed', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'alice', token_hash: hashToken('a'), hostname: 'h' });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('orch','wss://orch.example','tok','pod1','["topic","topic-subscribe"]',600,?)`).run(Date.now());
    routeSubscribe(db, 'alice', { type: 'subscribe', topic: 'orch:trollbox' } as never);
  });
  afterEach(() => { db.close(); });

  const unsubRows = () =>
    db.prepare("SELECT * FROM messages WHERE kind = 'topic-unsubscribe'").all() as { to_agent: string; topic: string }[];

  it('enqueues one teardown row, and only when something was removed', () => {
    expect(routeUnsubscribe(db, 'alice', { type: 'unsubscribe', topic: 'orch:trollbox' } as never).ok).toBe(true);
    expect(unsubRows().length).toBe(1);
    expect(unsubRows()[0]!.to_agent).toBe('orch:');

    // Idempotent, and the second call removed nothing — so it enqueues nothing.
    // A teardown row per retry would burn the peering's bucket on a no-op.
    routeUnsubscribe(db, 'alice', { type: 'unsubscribe', topic: 'orch:trollbox' } as never);
    expect(unsubRows().length).toBe(1);
  });

  // #129's contract is unchanged: unsubscribe NEVER refuses, for any cause.
  it('never refuses, even for a topic that does not exist', () => {
    expect(routeUnsubscribe(db, 'alice', { type: 'unsubscribe', topic: 'no:such' } as never).ok).toBe(true);
    expect(routeUnsubscribe(db, 'alice', { type: 'unsubscribe', topic: 'nothing' } as never).ok).toBe(true);
  });
});

// ── the hub side of subscribe/unsubscribe (routeRelay's arms) ────────────────
describe('F4 routeRelay: topic-subscribe and topic-unsubscribe', () => {
  let db: Database;

  const setup = (opts: { returnPeering?: boolean; returnKinds?: string } = {}) => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'hub-owner', token_hash: hashToken('h'), hostname: 'h' });
    getOrCreateTopic(db, 'trollbox', 'hub-owner');
    upsertPeer(db, {
      alias: 'pod1', token_hash: hashToken('p'), minted_by_key: 'k',
      kinds: '["topic-subscribe","topic-publish"]', rate_per_min: 600,
    });
    if (opts.returnPeering !== false) {
      db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                  VALUES ('pod1','wss://pod1.example','tok','orch',?,600,?)`)
        .run(opts.returnKinds ?? '["topic"]', Date.now());
    }
    return db;
  };
  afterEach(() => { db.close(); });

  const relay = (over: Record<string, unknown> = {}) => routeRelay(
    db, new Map(), getPeerByAlias(db, 'pod1')!,
    { type: 'relay', msg_id: `m-${Math.random()}`, kind: 'topic-subscribe', from: 'alice', topic: 'trollbox', ...over } as never,
  );

  beforeEach(() => resetRelayBuckets());

  it('records the remote subscriber, stamped with our alias for them', () => {
    setup();
    expect(relay().ok).toBe(true);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual(['pod1:alice']);
  });

  // THE SAME-ALIAS RETURN RULE (A3). `peers` and `outbound_peers` share no
  // column, so the only way the hub can know where to send this topic BACK is
  // to look for an outbound peering under the same alias. Without one, a
  // subscription would be recorded that can never be served — so it is refused
  // instead, uniformly.
  it('refuses when there is no RETURN peering to deliver on', () => {
    setup({ returnPeering: false });
    const r = relay();
    expect(r.ok).toBe(false);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual([]);
  });

  it('refuses when the return peering cannot carry topics', () => {
    setup({ returnKinds: '["direct"]' });
    expect(relay().ok).toBe(false);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual([]);
  });

  // THE `enabled` HALF, ISOLATED, and it exists because a mutant said the
  // other half was not being tested by what I thought was testing it. Deleting
  // the `returnPeering === null || enabled !== 1` check left every case above
  // green: with no row, `JSON.parse(returnPeering.kinds)` throws a TypeError
  // that the kinds `catch` turns into the SAME refusal. The explicit check
  // stays — a refusal that depends on a TypeError being caught by a JSON
  // handler is an accident, not a design — and this case pins the half that
  // accident cannot cover, because here the row EXISTS and only `enabled` is 0.
  it('refuses when the return peering is PAUSED', () => {
    setup();
    db.prepare("UPDATE outbound_peers SET enabled = 0 WHERE alias = 'pod1'").run();
    expect(relay().ok).toBe(false);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual([]);
  });

  // Remote callers never CREATE topics: a subscribe to a name the hub does not
  // own is refused rather than quietly conjuring a row, which would let any
  // peer populate our topics table.
  it('refuses a topic this mesh does not own, and creates nothing', () => {
    setup();
    expect(relay({ topic: 'nosuchtopic' }).ok).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM topics').get()).toEqual({ c: 1 });
  });

  it('unsubscribe removes the remote subscriber and always succeeds', () => {
    setup();
    relay();
    expect(getTopicSubscribers(db, 'trollbox')).toEqual(['pod1:alice']);

    expect(relay({ kind: 'topic-unsubscribe' }).ok).toBe(true);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual([]);
    // ...and again, for a subscription that is already gone.
    expect(relay({ kind: 'topic-unsubscribe' }).ok).toBe(true);
  });

  // §16 E — teardown is permitted even when the peering does not grant the
  // kind. A peer that may not stop subscribing is worse than one that may.
  it('§16 E: unsubscribe is accepted although the peering does not grant that kind', () => {
    setup();
    relay();
    // `topic-unsubscribe` is not in pod1's kinds — deliberately, it is not
    // grantable at all.
    expect(relay({ kind: 'topic-unsubscribe' }).ok).toBe(true);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual([]);
  });

  // ...but the malformed-column refusal still runs, so a broken row does not
  // become permissive for this one kind.
  it('§16 E: a malformed kinds column still refuses an unsubscribe', () => {
    setup();
    db.prepare("UPDATE peers SET kinds = 'not json' WHERE alias = 'pod1'").run();
    expect(relay({ kind: 'topic-unsubscribe' }).ok).toBe(false);
  });
});

// ── subscriptions end with the peering ───────────────────────────────────────
describe('F4 remote subscriptions end with the peering', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'owner', token_hash: hashToken('o'), hostname: 'h' });
    getOrCreateTopic(db, 'trollbox', 'owner');
    insertPeerKey(db, {
      id: 'key-1', key_hash: hashToken('k1'), alias: 'pod1',
      kinds: '["topic-subscribe"]', rate_per_min: 600, created_at: Date.now(),
    });
    upsertPeer(db, {
      alias: 'pod1', token_hash: hashToken('p'), minted_by_key: 'key-1',
      kinds: '["topic-subscribe"]', rate_per_min: 600,
    });
    db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?,?,?)')
      .run('pod1:alice', 'trollbox', Date.now());
    db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?,?,?)')
      .run('owner', 'trollbox', Date.now());
  });
  afterEach(() => { db.close(); });

  it('a REBIND (a new key that does not declare a rotation) drops them', () => {
    expect(getTopicSubscribers(db, 'trollbox').sort()).toEqual(['owner', 'pod1:alice']);
    upsertPeer(db, {
      alias: 'pod1', token_hash: hashToken('p2'), minted_by_key: 'key-2',
      kinds: '["topic-subscribe"]', rate_per_min: 600,
    });
    // Gone: whoever now holds the name must subscribe again.
    expect(getTopicSubscribers(db, 'trollbox')).toEqual(['owner']);
  });

  it('a ROTATION keeps them — the same peering, a new credential', () => {
    upsertPeer(db, {
      alias: 'pod1', token_hash: hashToken('p2'), minted_by_key: 'key-2',
      kinds: '["topic-subscribe"]', rate_per_min: 600, rotates: 'key-1',
    });
    expect(getTopicSubscribers(db, 'trollbox').sort()).toEqual(['owner', 'pod1:alice']);
  });

  it('REVOKING the key drops them, and leaves the local subscriber alone', () => {
    expect(revokePeerKey(db, 'key-1')).toBe(true);
    expect(getTopicSubscribers(db, 'trollbox')).toEqual(['owner']);
  });
});

// ── commit 6: spoke → hub post, and the transit invariant ────────────────────

describe('F4 routePublish: the remote-topic branch', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'alice', token_hash: hashToken('a'), hostname: 'h' });
    registerAgent(db, { id: 'local-sub', token_hash: hashToken('l'), hostname: 'h' });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('orch','wss://orch.example','tok','pod1','["topic","topic-subscribe","topic-publish"]',600,?)`)
      .run(Date.now());
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('nopost','wss://n.example','tok','pod1','["topic","topic-subscribe"]',600,?)`)
      .run(Date.now());
    routeSubscribe(db, 'alice', { type: 'subscribe', topic: 'orch:trollbox' } as never);
    routeSubscribe(db, 'local-sub', { type: 'subscribe', topic: 'orch:trollbox' } as never);
    aclGrant(db, 'alice', 'orch:trollbox', 'admin');        // the RIGHT TO POST
  });
  afterEach(() => { db.close(); });

  const publish = (topic: string, from = 'alice') =>
    routePublish(db, new Map(), from, { type: 'publish', msg_id: 'p1', topic, payload: 'hi' } as never);
  const posts = () =>
    db.prepare("SELECT * FROM messages WHERE kind = 'topic-publish'").all() as
      { to_agent: string; from_agent: string; topic: string; payload: string }[];

  it('enqueues ONE post row for the border, bare from and bare topic', () => {
    expect(publish('orch:trollbox').ok).toBe(true);
    const rows = posts();
    expect(rows.length).toBe(1);
    expect(rows[0]!.to_agent).toBe('orch:');
    expect(rows[0]!.from_agent).toBe('alice');
    expect(rows[0]!.topic).toBe('trollbox');
  });

  // C7 — THE ECHO. A remote publish does NOT fan out locally: local subscribers
  // hear it when the hub's delivery comes back. The hub is the ordering
  // authority, so a local shortcut would show this mesh's own agents a
  // different order from every other mesh's.
  it('does NOT fan out locally — the echo comes back from the hub', () => {
    publish('orch:trollbox');
    const local = db.prepare("SELECT COUNT(*) c FROM messages WHERE kind = 'topic'").get();
    expect(local).toEqual({ c: 0 });
  });

  it('refuses without the RIGHT TO POST edge, uniformly', () => {
    const r = publish('orch:trollbox', 'local-sub');       // no alice→topic edge
    expect(r).toEqual({
      ok: false, error_code: 'AGENT_NOT_FOUND', error_message: 'unknown topic: orch:trollbox',
    });
    expect(posts().length).toBe(0);
  });

  // The ONE non-uniform code on this path, and it sits BEHIND the ACL check —
  // which is what makes it affordable: a caller that reaches it has already
  // proven it holds an edge to this topic, so the reply reveals only the
  // caller's OWN mesh configuration.
  it('KIND_NOT_ALLOWED when the peering cannot carry a post — behind the ACL', () => {
    routeSubscribe(db, 'alice', { type: 'subscribe', topic: 'nopost:games' } as never);
    aclGrant(db, 'alice', 'nopost:games', 'admin');
    const r = publish('nopost:games');
    expect(r.ok).toBe(false);
    expect((r as { error_code: string }).error_code).toBe('KIND_NOT_ALLOWED');

    // ...and WITHOUT the edge, the same door answers the uniform refusal
    // instead: the distinct code is never reachable before the ACL.
    const r2 = publish('nopost:games', 'local-sub');
    expect((r2 as { error_code: string }).error_code).toBe('AGENT_NOT_FOUND');
  });
});

describe('F4 the hub re-originates a spoke post (transit)', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'owner', token_hash: hashToken('o'), hostname: 'h' });
    registerAgent(db, { id: 'hub-sub', token_hash: hashToken('hs'), hostname: 'h' });
    getOrCreateTopic(db, 'trollbox', 'owner');
    getOrCreateTopic(db, 'games', 'owner');
    for (const alias of ['pod1', 'pod2']) {
      upsertPeer(db, {
        alias, token_hash: hashToken(alias), minted_by_key: 'k',
        kinds: '["topic-publish","topic-subscribe"]', rate_per_min: 600,
      });
      db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                  VALUES (?, ?, 'tok', 'orch', '["topic"]', 600, ?)`).run(alias, `wss://${alias}.example`, Date.now());
    }
    aclGrant(db, 'pod1:alice', 'topic:trollbox', 'admin');   // pod1:alice may post
    subscribe(db, 'pod2:bob', 'trollbox');
    aclGrant(db, 'topic:trollbox', 'pod2:bob', 'admin');     // pod2:bob may hear
    subscribe(db, 'pod1:alice', 'trollbox');
    aclGrant(db, 'topic:trollbox', 'pod1:alice', 'admin');   // and so may the poster
  });
  afterEach(() => { db.close(); });

  const post = (over: Record<string, unknown> = {}) => routeRelay(
    db, new Map(), getPeerByAlias(db, 'pod1')!,
    {
      type: 'relay', msg_id: `m-${Math.random()}`, kind: 'topic-publish',
      from: 'alice', topic: 'trollbox', payload: 'hello', content_type: 'text/plain', ...over,
    } as never,
  );
  const outTo = (alias: string) =>
    db.prepare("SELECT * FROM messages WHERE to_agent = ? AND kind = 'topic'").all(`${alias}:`) as
      { id: string; origin: string | null; expires_at: number; payload: string }[];

  it('pod1 → orch → pod2, exactly once, with pod1 the origin', () => {
    expect(post().ok).toBe(true);
    expect(outTo('pod2').length).toBe(1);
    expect(outTo('pod2')[0]!.origin).toBe('pod1:alice');
    expect(outTo('pod2')[0]!.payload).toBe('hello');
  });

  // THE ECHO, from the hub's side: one frame per peering cannot exclude the
  // publisher's own mesh, so pod1 gets the post back — exactly as a chat shows
  // your own message. Suppressing it would mean routing on `origin`.
  it('the posting pod receives the echo', () => {
    post();
    expect(outTo('pod1').length).toBe(1);
    expect(outTo('pod1')[0]!.origin).toBe('pod1:alice');
  });

  // M7 — a FRESH id at the hub. Reusing the arriving msg_id would make the
  // hub's retry indistinguishable from a redelivery on the far side.
  it('the hub\'s outbound ids are fresh, and differ from the arriving msg_id', () => {
    const arriving = 'arriving-id-1';
    post({ msg_id: arriving });
    const ids = [...outTo('pod1'), ...outTo('pod2')].map(r => r.id);
    expect(ids.length).toBe(2);
    for (const id of ids) expect(id).not.toBe(arriving);
    expect(new Set(ids).size).toBe(2);
    // ...and the arriving id is recorded in `relays`, which is where a remote
    // namespace belongs.
    expect(db.prepare('SELECT COUNT(*) c FROM relays WHERE remote_msg_id = ?').get(arriving)).toEqual({ c: 1 });
  });

  // M14 — the transited post's budget is THIS frame's, clamped. Deriving it
  // from the 5-minute default would let a spoke's short-lived post outlive its
  // sender's intent, or a long one be cut short.
  it('expires_at comes from the arriving frame\'s ttl, never a default', () => {
    const before = Date.now();
    post({ ttl_ms: 60_000 });
    const row = outTo('pod2')[0]!;
    expect(row.expires_at - before).toBeLessThanOrEqual(60_050);
    expect(row.expires_at - before).toBeGreaterThan(50_000);
  });

  it('a ttl beyond the dedupe window is clamped, not honoured', () => {
    const before = Date.now();
    post({ ttl_ms: MAX_TTL_MS * 10 });
    expect(outTo('pod2')[0]!.expires_at - before).toBeLessThanOrEqual(MAX_TTL_MS + 50);
  });

  // M3 — the isHomeTopic guard. A post naming a topic this mesh does not own
  // must produce nothing: without the guard the hub would relay on behalf of a
  // third mesh, which is the transitive federation nobody agreed to.
  it('M3 control: a post for a topic this mesh does not own yields no outbound row', () => {
    // `pod2:games` is foreign here — the prefix names an outbound peering.
    getOrCreateTopic(db, 'pod2:games', 'owner');
    const r = post({ topic: 'pod2:games' });
    expect(r.ok).toBe(false);            // bad_topic: a ':' in a relayed topic
    expect(outTo('pod2').length).toBe(0);
  });

  it('M3 control: a post for a topic that does not exist at all yields nothing', () => {
    expect(post({ topic: 'nosuchtopic' }).ok).toBe(false);
    expect(outTo('pod1').length + outTo('pod2').length).toBe(0);
  });

  // M15 — THE HUB'S LOCAL FAN-OUT USES THE TOPIC PRINCIPAL, not the poster.
  // A hub subscriber holds `topic:trollbox → hub-sub`; it holds nothing from
  // `pod1:alice`, and it must still receive.
  it('M15: a hub subscriber holding only the TOPIC edge receives the post', () => {
    subscribe(db, 'hub-sub', 'trollbox');
    aclGrant(db, 'topic:trollbox', 'hub-sub', 'admin');
    expect(aclCheck(db, 'pod1:alice', 'hub-sub')).toBe(false);   // POSITIVE CONTROL

    post();

    const local = db.prepare("SELECT to_agent FROM messages WHERE kind='topic' AND to_agent = 'hub-sub'").all();
    expect(local.length).toBe(1);
  });

  it('refuses a post from a peer with no RIGHT TO POST edge', () => {
    upsertPeer(db, {
      alias: 'pod2', token_hash: hashToken('pod2'), minted_by_key: 'k',
      kinds: '["topic-publish"]', rate_per_min: 600,
    });
    const r = routeRelay(db, new Map(), getPeerByAlias(db, 'pod2')!, {
      type: 'relay', msg_id: 'm-nopost', kind: 'topic-publish',
      from: 'mallory', topic: 'trollbox', payload: 'x',
    } as never);
    expect(r.ok).toBe(false);
    expect(outTo('pod1').length + outTo('pod2').length).toBe(0);
  });
});

// ── the three cases the §11 mutant sweep asked for ───────────────────────────
//
// M3, M5 and M10 all SURVIVED the first sweep of this commit, and none of them
// was a code defect: each was a guard with no test that could see it. M3 in
// particular is the accidental-equivalence shape again — deleting the
// `isHomeTopic` guard left my two "control" cases green because both of their
// topics failed a LATER check for an unrelated reason.
describe('F4 guards the mutant sweep found unpinned', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'owner', token_hash: hashToken('o'), hostname: 'h' });
    getOrCreateTopic(db, 'trollbox', 'owner');
    upsertPeer(db, {
      alias: 'pod1', token_hash: hashToken('p'), minted_by_key: 'k',
      kinds: '["topic-publish"]', rate_per_min: 600,
    });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('pod1','wss://pod1.example','tok','orch','["topic"]',600,?)`).run(Date.now());
    aclGrant(db, 'pod1:alice', 'topic:trollbox', 'admin');
    subscribe(db, 'pod1:alice', 'trollbox');
    aclGrant(db, 'topic:trollbox', 'pod1:alice', 'admin');
  });
  afterEach(() => { db.close(); });

  const post = (over: Record<string, unknown> = {}) => routeRelay(
    db, new Map(), getPeerByAlias(db, 'pod1')!,
    {
      type: 'relay', msg_id: `m-${Math.random()}`, kind: 'topic-publish',
      from: 'alice', topic: 'trollbox', payload: 'hello', ...over,
    } as never,
  );

  // M3, PROPERLY. The guard is only reachable when everything AFTER it would
  // have passed: a topic that does not exist, WITH the post edge granted. My
  // earlier controls used topics that also had no edge, so the refusal came
  // from the ACL and the mutant survived.
  it('M3: a post edge for a topic that does not exist is still refused, and writes nothing', () => {
    aclGrant(db, 'pod1:alice', 'topic:ghosttopic', 'admin');
    expect(aclCheck(db, 'pod1:alice', 'topic:ghosttopic')).toBe(true);   // POSITIVE CONTROL

    expect(post({ topic: 'ghosttopic' }).ok).toBe(false);

    expect(db.prepare("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM topics WHERE name = 'ghosttopic'").get()).toEqual({ c: 0 });
  });

  // M5. The re-originated row is FROM the topic principal — the hub owns the
  // post now — with the real speaker recorded in `origin`, for display. Using
  // the publisher as `from_agent` would make a remote id the sender of a local
  // topic row, and every ACL downstream would read it.
  it('M5: the re-originated row is FROM the topic principal, with origin beside it', () => {
    // A LOCAL subscriber is required for this test to see anything. The
    // OUTBOUND row's `from_agent` is computed inside the enqueue from the topic
    // name, so it is immune to the ctx — which is why the first version of this
    // test, asserting only the outbound row, left the mutant green. The row
    // that carries `m.from_agent` is the locally fanned-out one.
    registerAgent(db, { id: 'hub-sub', token_hash: hashToken('hs'), hostname: 'h' });
    subscribe(db, 'hub-sub', 'trollbox');
    aclGrant(db, 'topic:trollbox', 'hub-sub', 'admin');

    post();

    const local = db.prepare("SELECT from_agent, origin FROM messages WHERE to_agent = 'hub-sub'")
      .get() as { from_agent: string; origin: string };
    expect(local.from_agent).toBe('topic:trollbox');
    expect(local.origin).toBe('pod1:alice');

    const outbound = db.prepare("SELECT from_agent, origin FROM messages WHERE to_agent = 'pod1:' AND kind = 'topic'")
      .get() as { from_agent: string; origin: string };
    expect(outbound.from_agent).toBe('topic:trollbox');
    expect(outbound.origin).toBe('pod1:alice');
  });

  // M10. ONE HOP: a ':' in a relayed `from` would mean this peer is relaying on
  // behalf of a THIRD mesh — transitive federation nobody agreed to. Our
  // admin's border decision covers this peer, not that peer's peers.
  it('M10: a relayed `from` containing a colon is refused on every topic kind', () => {
    for (const kind of ['topic-publish', 'topic-subscribe', 'topic-unsubscribe']) {
      const r = post({ kind, from: 'pod9:mallory' });
      expect({ kind, ok: r.ok }).toEqual({ kind, ok: false });
    }
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM subscriptions WHERE agent_id LIKE '%pod9%'").get()).toEqual({ c: 0 });
  });

  it('CONTROL: the same frames with a bare `from` are accepted', () => {
    expect(post().ok).toBe(true);
  });
});

// ── the echo, on the SPOKE side (M6, second reading) ─────────────────────────
//
// The hub-side echo — the posting pod's own peering is not skipped — is pinned
// in the transit block. This is the other place suppression could be written:
// the SPOKE dropping a delivery whose `origin` names one of ITS agents. The
// mutant that does exactly that survived the whole suite until this test, and
// it is the more tempting of the two, because it looks like "do not show
// someone their own message" rather than like "route on origin".
//
// It IS routing on origin, which is forbidden — `origin` is a string the far
// mesh chose. A peer could suppress any local agent's deliveries by forging it.
describe('F4 the spoke does not suppress its own agents\' echoes', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'alice', token_hash: hashToken('a'), hostname: 'h' });
    upsertPeer(db, {
      alias: 'orch', token_hash: hashToken('o'), minted_by_key: 'k',
      kinds: '["topic"]', rate_per_min: 600,
    });
    getOrCreateTopic(db, 'orch:trollbox', 'alice');
    subscribe(db, 'alice', 'orch:trollbox');
    aclGrant(db, 'orch:trollbox', 'alice', 'admin');
  });
  afterEach(() => { db.close(); });

  it('a delivery whose origin names a LOCAL agent is still delivered to that agent', () => {
    const sock = fakeSocket();
    const r = routeRelay(db, new Map([['alice', sock]]), getPeerByAlias(db, 'orch')!, {
      type: 'relay', msg_id: 'echo-1', kind: 'topic', from: 'trollbox', topic: 'trollbox',
      origin: 'pod1:alice', payload: 'my own post', content_type: 'text/plain',
    } as never);
    expect(r.ok).toBe(true);

    // alice posted it (as far as `origin` claims) and alice receives it.
    expect(sock.sent.length).toBe(1);
    expect(JSON.parse(sock.sent[0]!).payload).toBe('my own post');
  });

  // AND THE ATTACK THE SUPPRESSION WOULD CREATE, which is why the rule is not
  // merely a preference: if a delivery were dropped because `origin` names a
  // local agent, a peer could silence any agent it can name by forging it.
  it('a FORGED origin naming a local agent cannot suppress that agent\'s delivery', () => {
    const sock = fakeSocket();
    routeRelay(db, new Map([['alice', sock]]), getPeerByAlias(db, 'orch')!, {
      type: 'relay', msg_id: 'forged-1', kind: 'topic', from: 'trollbox', topic: 'trollbox',
      origin: 'orch:alice', payload: 'you should still see this', content_type: 'text/plain',
    } as never);
    expect(sock.sent.length).toBe(1);
  });
});

// ── §16 L: what a PAUSED outbound peering does to its topics ─────────────────
//
// Documented (FEDERATION.md §3) and, until this test, unpinned. `hasOutboundPeer`
// is enabled-only, so while a spoke's peering is PATCH-disabled `isHomeTopic`
// calls `orch:trollbox` a HOME topic on that spoke: a post fans out LOCALLY
// instead of queueing for the border.
//
// That is accepted for v1, and it is the kind of accepted behaviour that most
// needs a test — an operator pausing a peering gets a topic that keeps working
// locally and silently stops federating, and the only thing standing between
// "documented decision" and "surprise" is a test that fails if it ever changes
// by accident.
//
// WHICH GUARD ACTUALLY PRODUCES IT, because I got this wrong first: for a
// PUBLISH the behaviour comes from `routePublish`'s remote-branch test
// (`hasOutboundPeer`, which is enabled-only), NOT from `isHomeTopic` — the
// local publish path never consults `isHomeTopic` at all. My first mutant
// changed `isHomeTopic` and these tests stayed green, correctly. The mutant
// that reds them makes `routePublish`'s branch enabled-insensitive, which is
// the real §16 L mechanism. `isHomeTopic`'s own enabled-sensitivity governs
// routeRelay's arms and is pinned there.
describe('F4 §16 L: a paused peering makes its topics local again', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'poster', token_hash: hashToken('p'), hostname: 'h' });
    registerAgent(db, { id: 'local-sub', token_hash: hashToken('s'), hostname: 'h' });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('orch','wss://orch.example','tok','pod1','["topic","topic-subscribe","topic-publish"]',600,?)`)
      .run(Date.now());
    // Both agents subscribe while the peering is UP, which is how the local
    // topics row and the subscriptions come to exist at all.
    routeSubscribe(db, 'local-sub', { type: 'subscribe', topic: 'orch:trollbox' } as never);
    aclGrant(db, 'poster', 'local-sub', 'system');
    aclGrant(db, 'poster', 'orch:trollbox', 'admin');       // the RIGHT TO POST, while up
  });
  afterEach(() => { db.close(); });

  const pause = () => db.prepare("UPDATE outbound_peers SET enabled = 0 WHERE alias = 'orch'").run();
  const resume = () => db.prepare("UPDATE outbound_peers SET enabled = 1 WHERE alias = 'orch'").run();
  const publish = () => routePublish(db, new Map(), 'poster',
    { type: 'publish', msg_id: `p-${Math.random()}`, topic: 'orch:trollbox', payload: 'hi' } as never);
  const rowsTo = (to: string, kind: string) =>
    (db.prepare('SELECT COUNT(*) c FROM messages WHERE to_agent = ? AND kind = ?').get(to, kind) as { c: number }).c;

  it('while PAUSED, a post fans out locally and queues nothing for the border', () => {
    pause();
    expect(publish().ok).toBe(true);

    // The local subscriber is served...
    expect(rowsTo('local-sub', 'topic')).toBe(1);
    // ...and nothing is queued for a peering that is not carrying anything.
    expect(rowsTo('orch:', 'topic-publish')).toBe(0);
    expect(rowsTo('orch:', 'topic')).toBe(0);
  });

  // THE CONTROL, and it is what makes the case above a statement about PAUSING
  // rather than about this fixture: enabled, the same publish goes the other
  // way entirely — to the border, and NOT to the local subscriber (C7: the
  // echo returns from the hub).
  it('CONTROL: enabled, the same post goes to the border and not to the local subscriber', () => {
    expect(publish().ok).toBe(true);
    expect(rowsTo('orch:', 'topic-publish')).toBe(1);
    expect(rowsTo('local-sub', 'topic')).toBe(0);
  });

  it('a post queued while UP survives the pause and is still deliverable after resume', () => {
    publish();                                   // queued for the border
    expect(rowsTo('orch:', 'topic-publish')).toBe(1);

    pause();
    publish();                                   // this one goes local
    resume();

    // The queued row is untouched by the pause: still there, not expired, not
    // failed. WHAT THIS DOES NOT SHOW is a forwarder delivering it — draining
    // is border.ts's job and needs a live peer. What it pins is that pausing
    // does not destroy or expire the backlog, which is the half an operator
    // would be surprised by.
    const queued = db.prepare(
      `SELECT COUNT(*) c FROM messages
       WHERE to_agent = 'orch:' AND kind = 'topic-publish'
         AND delivered_at IS NULL AND failed_code IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`).get(Date.now()) as { c: number };
    expect(queued).toEqual({ c: 1 });
  });
});

// ── P16: a PAUSED hub→spoke peering gets NO row ─────────────────────────────
//
// The plan said posts QUEUE for a paused peering and drain on resume. They do
// not, and the code is right: `enqueueOutboundTopicRows` iterates
// `listEnabledOutboundPeers`, so a disabled peering is never considered and the
// post is DROPPED for that spoke.
//
// Which is the correct behaviour for a topic, and worth stating rather than
// merely correcting: a queued post would arrive minutes or hours late into a
// live conversation, and the dedupe window would expire most of it anyway.
// Pausing a topic peering means that mesh misses what it missed.
//
// §16 L's "rows already queued still drain" is about `topic-publish` rows a
// SPOKE queued before its own peering paused — a different direction and a
// different row kind. The two are easy to conflate, which is why both are
// pinned.
describe('F4 P16: a paused hub→spoke peering drops, it does not queue', () => {
  let db: Database;

  beforeEach(() => {
    resetRelayBuckets();
    db = openDb(':memory:');
    registerAgent(db, { id: 'hub-pub', token_hash: hashToken('p'), hostname: 'h' });
    getOrCreateTopic(db, 'trollbox', 'hub-pub');
    for (const alias of ['pod1', 'pod2']) {
      db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                  VALUES (?, ?, 'tok', 'orch', '["topic"]', 600, ?)`).run(alias, `wss://${alias}.example`, Date.now());
      subscribe(db, `${alias}:sub`, 'trollbox');
      aclGrant(db, 'topic:trollbox', `${alias}:sub`, 'admin');
    }
  });
  afterEach(() => { db.close(); });

  const rowsTo = (alias: string) =>
    (db.prepare("SELECT COUNT(*) c FROM messages WHERE to_agent = ? AND kind = 'topic'").get(`${alias}:`) as { c: number }).c;
  const publish = () => routePublish(db, new Map(), 'hub-pub',
    { type: 'publish', topic: 'trollbox', payload: 'hi' } as never);

  it('no row is written for a peering that is paused', () => {
    db.prepare("UPDATE outbound_peers SET enabled = 0 WHERE alias = 'pod2'").run();
    publish();

    expect(rowsTo('pod1')).toBe(1);
    // Not queued for later: dropped. pod2 misses what it missed.
    expect(rowsTo('pod2')).toBe(0);
  });

  it('CONTROL: enabled, the same publish writes one row for each', () => {
    publish();
    expect(rowsTo('pod1')).toBe(1);
    expect(rowsTo('pod2')).toBe(1);
  });

  it('resuming does not retroactively produce the missed post', () => {
    db.prepare("UPDATE outbound_peers SET enabled = 0 WHERE alias = 'pod2'").run();
    publish();
    db.prepare("UPDATE outbound_peers SET enabled = 1 WHERE alias = 'pod2'").run();

    // Nothing appears on resume — there was never a row to drain.
    expect(rowsTo('pod2')).toBe(0);
  });
});
