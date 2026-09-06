import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  getAgentById,
  aclCheck,
  hasOutboundPeer,
  getOutboundPeer,
  type Peer,
  insertMessage,
  getMessage,
  markDelivered,
  getPendingMessages,
  getOrCreateTopic,
  getTopicSubscribers,
  isRemoteEndpoint,
  topicExists,
  topicNameRefusal,
  subscribeCreated,
  unsubscribeRemoved,
  listEnabledOutboundPeers,
  listRemoteSubscribers,
  TOPIC_PRINCIPAL_PREFIX,
  subscribe as dbSubscribe,
  Message,
  insertFile,
  getFile,
  markFileDelivered,
  FileRecord,
  listCrossBorderObservers,
} from './db.ts';
import { incMsgStatus, incSent, incReceived, incAclDenied, incTopicFanout, incError, incBytes, incFile, observePayloadBytes, incPeerRelay } from './metrics.ts';
import { emitTap, LOCAL_ONLY, type TapAudience } from './tap.ts';
import { borderEvents } from './border.ts';

// Wire-frame types live in the shared client package (single source of truth).
// Import them for local type annotations AND re-export so existing importers of
// these names from './router.ts' (e.g. ws-server.ts) keep resolving unchanged.
import type {
  SendFrame, PublishFrame, SubscribeFrame, UnsubscribeFrame,
  FileSendFrame,
} from '../client/src/protocol.ts';
export type {
  SendFrame, PublishFrame, SubscribeFrame, UnsubscribeFrame,
  FileSendFrame,
};

export interface RouterResult {
  ok: boolean;
  msg_id?: string;
  error_code?: string;
  error_message?: string;
  fileId?: string; // #60: routeFile returns the stored file's id (absent if dropped)
}

export function buildDeliverFrame(msg: {
  id: string;
  kind: string;
  from_agent: string;
  to_agent: string | null;
  topic: string | null;
  correlation_id: string | null;
  payload: string;
  content_type: string;
  sent_at: number;
  /** F4 §16 C — REQUIRED, not optional. Every call site states what the
   *  provenance is, including the ones where it is `null`, because an optional
   *  field would let a new delivery path forget it and ship a topic frame with
   *  no origin that looks exactly like a local one. The callers that pass a
   *  whole `Message` get it from the row for free. */
  origin: string | null;
}): string {
  return JSON.stringify({
    type: 'deliver',
    msg_id: msg.id,
    kind: msg.kind,
    from: msg.from_agent,
    to: msg.to_agent,
    topic: msg.topic,
    correlation_id: msg.correlation_id,
    payload: msg.payload,
    content_type: msg.content_type,
    sent_at: msg.sent_at,
    origin: msg.origin,
  });
}

/** One message's worth of delivery state, as deliverOrQueue needs it. */
export interface DeliverableMessage {
  id: string;
  from_agent: string;
  to_agent: string;
  payload: string;
  content_type: string;
  sent_at: number;
  expires_at: number | null;
  /** ttl_ms === 0: deliver live but persist nothing (and hence nothing to mark
   *  delivered). Offline + ephemeral is dropped, not queued. */
  ephemeral: boolean;
  payloadBytes: number;
}

/**
 * Deliver to a connected recipient, or queue for an offline one — the single
 * implementation shared by routeDirect and the relay handler (F1b, §5.2).
 *
 * SYNCHRONOUS, and that is load-bearing rather than incidental: routeDirect's
 * duplicate check and its insert must not be separated by an await, or two
 * frames interleave, both pass the check, and the second insert throws. Every
 * statement here is synchronous bun:sqlite or ws.send work.
 */
export function deliverOrQueue(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  msg: DeliverableMessage
): void {
  const recipientWs = agentIndex.get(msg.to_agent);
  if (recipientWs !== undefined) {
    if (!msg.ephemeral) {
      insertMessage(db, {
        id: msg.id, kind: 'direct', from_agent: msg.from_agent, to_agent: msg.to_agent,
        payload: msg.payload, content_type: msg.content_type,
        sent_at: msg.sent_at, expires_at: msg.expires_at,
      });
    }
    recipientWs.send(buildDeliverFrame({
      id: msg.id, kind: 'direct', from_agent: msg.from_agent, to_agent: msg.to_agent,
      topic: null, correlation_id: null, payload: msg.payload,
      content_type: msg.content_type, sent_at: msg.sent_at,
      origin: null,   // a direct message has no cross-mesh provenance
    }));
    if (!msg.ephemeral) markDelivered(db, msg.id);
    incMsgStatus('direct', 'delivered');
    incReceived(msg.to_agent);
    incBytes('out', msg.payloadBytes);
    return;
  }

  // Offline. ttl 0 is discarded rather than queued: an ephemeral message's
  // whole point is that it is worthless later.
  if (msg.ephemeral) {
    incMsgStatus('direct', 'dropped');
    return;
  }
  insertMessage(db, {
    id: msg.id, kind: 'direct', from_agent: msg.from_agent, to_agent: msg.to_agent,
    payload: msg.payload, content_type: msg.content_type,
    sent_at: msg.sent_at, expires_at: msg.expires_at,
  });
  incMsgStatus('direct', 'queued');
}

// ──────────────────────────────────────────────
// 5.9 Inbound relay (F1b — §5.2)
// ──────────────────────────────────────────────

/** Per-alias sliding-minute counter. In memory: a rate limit is about the
 *  CURRENT connection's behaviour, and persisting it would let a restart
 *  either forgive a flood or punish a peer for one it has already stopped. */
/**
 * F2b (b): the largest ttl a caller may ask for, either direction.
 *
 * Set to the relay dedupe window (7 days) rather than something larger,
 * because beyond it the row is unsendable anyway: the receiver has forgotten
 * the remote msg_id, so the forwarder expires such rows rather than
 * re-delivering them. A ttl past that point promises storage the system will
 * not honour, which is worse than refusing it.
 *
 * NEGATIVE ttls are REFUSED, not clamped to 0: 0 already means something
 * specific here (ephemeral — deliver live or drop), so silently mapping -5
 * onto it would turn a malformed frame into a different valid request.
 */
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const relayBuckets = new Map<string, { windowStart: number; count: number }>();

/** Exported for tests only — a bucket that survives between cases would make
 *  the rate test depend on execution order. */
export function resetRelayBuckets(): void {
  relayBuckets.clear();
}

/** Returns true if this relay is WITHIN the peer's rate. Counts EVERY relay,
 *  including ones about to be refused: otherwise a peer can probe the mesh for
 *  free by sending frames it knows will fail. */
function withinRate(alias: string, limitPerMin: number, now: number): boolean {
  const b = relayBuckets.get(alias);
  if (b === undefined || now - b.windowStart >= 60_000) {
    relayBuckets.set(alias, { windowStart: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= limitPerMin;
}

export interface RelayFrameIn {
  type: 'relay';
  msg_id?: unknown;
  kind?: unknown;
  from?: unknown;
  to?: unknown;
  payload?: unknown;
  content_type?: unknown;
  ttl_ms?: unknown;
  /** F4: present on every topic kind, absent on `direct`. */
  topic?: unknown;
  /** F4: display-only provenance, set by the SENDING mesh. Attacker-supplied:
   *  validated for shape and then carried, never routed on. */
  origin?: unknown;
}

/**
 * Handle one `relay` frame from an authenticated PEER socket.
 *
 * FULLY SYNCHRONOUS — zero awaits anywhere. Every step is synchronous
 * bun:sqlite or ws.send work, and that is a stated invariant rather than an
 * accident: the dedupe check and the `relays` insert must not be separated by
 * an await, or two frames interleave, both pass, and the second insert throws.
 * The ONLY position an await could ever be added is AFTER the ack has been
 * sent, and nothing here needs one.
 *
 * Does NOT call routeDirect: that path is for a LOCAL sender and applies rules
 * (duplicate msg_id against messages.id, local ACL from a bare id) that mean
 * something different here. It shares deliverOrQueue, which is the part that
 * must not diverge.
 *
 * REFUSALS ARE UNIFORM. Everything except the rate limit answers
 * RELAY_REFUSED: a peer learns that its frame was refused and nothing about
 * WHY — not whether the recipient exists, not whether an edge exists, not
 * whether the kind is permitted. Distinguishing them would make this endpoint
 * an enumeration oracle for our local agents. RATE_LIMITED is deliberately
 * distinguishable because it is the one refusal the peer can act on.
 */
const NO_OBSERVERS: ReadonlySet<string> = new Set();

/**
 * F4 §2 — is this topic OURS to fan out, or a mirror of another mesh's?
 *
 * THE TEST IS THE PREFIX, NEVER ROW EXISTENCE. A spoke really does hold a local
 * `topics` row called `orch:trollbox` — `routeSubscribe` creates it so the
 * subscription has something to point at — so "the row is here" would call
 * every mirrored topic home and the hub-and-spoke direction would collapse.
 *
 * A name is foreign iff its prefix names an OUTBOUND peering: that is the
 * peering the post would have to leave through, so if there is none, the name's
 * colon is just a colon and the topic is local (a legacy name, or one created
 * before its peering existed).
 *
 * §16 L, a consequence worth stating where it is decided: `hasOutboundPeer` is
 * enabled-only, so while a spoke's peering is PAUSED its `orch:` topics become
 * home topics and posts fan out LOCALLY instead of queueing for the border.
 * Accepted for v1 — rows already queued still drain on re-enable.
 */
export function isHomeTopic(db: Database, t: string): boolean {
  if (!topicExists(db, t)) return false;
  const i = t.indexOf(':');
  if (i <= 0) return true;
  return !hasOutboundPeer(db, t.slice(0, i));
}

/**
 * F4 §7 — the LOCAL half of a topic fan-out, extracted from `routePublish` so
 * that both publish paths and the inbound border arm share exactly one copy.
 *
 * Three callers will exist and they differ only in their inputs: a local
 * publish (`aclPrincipal` = the publisher), a hub re-originating a spoke's post
 * (`aclPrincipal` = the topic principal), and a spoke delivering an arriving
 * `topic` frame (`aclPrincipal` = the stamped remote topic). Everything they do
 * to a subscriber is identical, and a second copy is how the ACL principal
 * silently becomes the wrong one on one of the three.
 *
 * REMOTE SUBSCRIBERS ARE SKIPPED (A2). `subscriptions.agent_id` may now name
 * `pod1:alice`, and this mesh cannot deliver to it: a `messages` row addressed
 * to a bare remote id matches no drain range and is read by nobody, so it would
 * sit in the queue until it expired. Remote subscribers are served by the
 * border rows instead. The filter is `isRemoteEndpoint`, an AGENT LOOKUP rather
 * than a colon test, so a legacy local id containing ':' still receives.
 *
 * CONTAINS NO `emitTap` AND NO BORDER ENQUEUE, deliberately. `observer-cross-
 * border.test.ts` scans this file for the set of function names containing an
 * `emitTap(` call and asserts equality with its driven list, and the border
 * enqueue has exactly one call site by contract (§15); putting either here
 * would break a guarantee that is checked structurally rather than by
 * behaviour.
 */
export function fanOutTopicLocal(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  m: {
    topic: string;
    from_agent: string;
    origin: string | null;
    payload: string;
    content_type: string;
    sent_at: number;
    expires_at: number | null;
    ephemeral: boolean;
    /** The principal the per-subscriber ACL is evaluated FROM. Not always
     *  `from_agent`: on a hub it is the topic principal, so a subscriber's
     *  right to hear is a property of the topic rather than of whoever posted. */
    aclPrincipal: string;
    payloadBytes: number;
  },
): void {
  const subscribers = getTopicSubscribers(db, m.topic)
    .filter(id => id !== m.from_agent)
    .filter(id => !isRemoteEndpoint(db, id));

  for (const subscriber_id of subscribers) {

    // 5a. ACL check.
    //
    // THE GATE STAYS. Removing it for system topics was one of the options on
    // #136 and it is wrong: routeSubscribe calls getOrCreateTopic with no ACL
    // check, so ANY authenticated agent can subscribe to sys.presence.turn.
    // Ungating the fan-out would hand every subscriber the activity of the
    // entire roster — the same enumeration #125, #128 and #129 exist to close.
    //
    // WHAT CHANGES IS THE COUNTING, and it is not about system topics at all.
    // On a topic publish the sender does NOT choose the recipients: it names a
    // topic, and the ACL filters the subscriber list. Counting each filtered
    // subscriber as an "ACL-denied send attempt by sender" is a semantics error
    // for EVERY topic — the sender attempted one publish, not N sends to N
    // agents it never named. sys.presence.turn only made it visible, by being
    // published ~2/s fleet-wide.
    //
    // mesh_acl_denied_total and mesh_errors_total{ACL_DENIED} are therefore for
    // DIRECT sends, where the sender did choose the recipient. Fan-out outcomes
    // go to mesh_topic_fanout_total, which carries no topic label because topic
    // names are agent-chosen.
    if (!aclCheck(db, m.aclPrincipal, subscriber_id)) {
      incTopicFanout('filtered');
      continue;
    }
    // 'allowed', not 'delivered': this is where the ACL decision is made, and
    // the online/offline branch below has not run yet. mesh_messages_total is
    // the authority on delivery.
    incTopicFanout('allowed');

    // 5b. Unique msg_id per subscriber copy
    const msgId = crypto.randomUUID();

    // 5c. Online
    const recipientWs = agentIndex.get(subscriber_id);
    if (recipientWs !== undefined) {
      // ttl_ms=0 = EPHEMERAL: deliver live, persist nothing (see routeDirect).
      // Beat/heartbeat topics (e.g. turn-status) use this so they never
      // accumulate as scrollback history and starve real-message reads.
      if (!m.ephemeral) {
        insertMessage(db, {
          id: msgId,
          kind: 'topic',
          from_agent: m.from_agent,
          to_agent: subscriber_id,
          topic: m.topic,
          payload: m.payload,
          content_type: m.content_type,
          sent_at: m.sent_at,
          expires_at: m.expires_at,
          origin: m.origin,
        });
      }
      recipientWs.send(buildDeliverFrame({
        id: msgId,
        kind: 'topic',
        from_agent: m.from_agent,
        to_agent: null,
        topic: m.topic,
        correlation_id: null,
        payload: m.payload,
        content_type: m.content_type,
        sent_at: m.sent_at,
        origin: m.origin,
      }));
      if (!m.ephemeral) markDelivered(db, msgId);
      incMsgStatus('topic', 'delivered');
      incReceived(subscriber_id);
      incBytes('out', m.payloadBytes);
    } else {
      // 5d. Offline
      if (m.ephemeral) {
        incMsgStatus('topic', 'dropped');
        continue;
      }
      insertMessage(db, {
        id: msgId,
        kind: 'topic',
        from_agent: m.from_agent,
        to_agent: subscriber_id,
        topic: m.topic,
        payload: m.payload,
        content_type: m.content_type,
        sent_at: m.sent_at,
        expires_at: m.expires_at,
        origin: m.origin,
      });
      incMsgStatus('topic', 'queued');
    }
  }
}

/**
 * F4 §7 — ONE outbound row per PEERING, never per remote subscriber.
 *
 * That is the entire economy of hub-and-spoke: a pod with fifty subscribers
 * costs the hub one border frame and one rate token, and the pod fans out with
 * its own ACL. Per-subscriber rows would multiply both, and the rate bucket is
 * per peering — so a busy topic would rate-limit that peering's direct traffic
 * fifty times faster.
 *
 * TWO GATES, BOTH ON THE SENDING SIDE, and neither substitutes for the other:
 * the peering must be enabled AND carry kind `topic` (the admin's decision
 * about what may leave), and at least one of that pod's subscribers must hold
 * the RIGHT TO HEAR edge from the topic principal (the ACL's decision about
 * whether the topic may reach that mesh at all). With no permitted subscriber
 * nothing leaves — not "leaves and is filtered there".
 *
 * A FRESH `crypto.randomUUID()` per row (§16 A): `routePublish` has no
 * duplicate check, so a reused id throws a bare SQLite constraint error, and
 * reuse across the hub would also destroy the hub's retry idempotency.
 *
 * EXACTLY ONE CALL SITE, EVER — `fanOutHomeTopicPublish` below. Both publish
 * paths route through that, so the guarantee survives having two callers. It is
 * checked structurally, not by convention.
 *
 * Returns the rows it wrote so the caller can emit one cross-border tap each;
 * emitting them here would break `observer-cross-border.test.ts`'s scan of
 * which router functions contain `emitTap(`.
 */
export function enqueueOutboundTopicRows(
  db: Database,
  m: {
    topic: string;
    origin: string | null;
    payload: string;
    content_type: string;
    sent_at: number;
    expires_at: number | null;
  },
): { alias: string; id: string }[] {
  const written: { alias: string; id: string }[] = [];
  for (const peering of listEnabledOutboundPeers(db)) {
    let kinds: string[];
    try { kinds = JSON.parse(peering.kinds) as string[]; } catch { continue; }
    if (!Array.isArray(kinds) || !kinds.includes('topic')) continue;

    const subs = listRemoteSubscribers(db, peering.alias, m.topic);
    if (!subs.some(id => aclCheck(db, `${TOPIC_PRINCIPAL_PREFIX}${m.topic}`, id))) continue;

    const id = crypto.randomUUID();
    insertMessage(db, {
      id,
      kind: 'topic',
      from_agent: `${TOPIC_PRINCIPAL_PREFIX}${m.topic}`,
      to_agent: `${peering.alias}:`,   // the peering, not an agent; the drain ranges on it
      topic: m.topic,
      payload: m.payload,
      content_type: m.content_type,
      sent_at: m.sent_at,
      expires_at: m.expires_at,
      origin: m.origin,
    });
    incMsgStatus('topic', 'queued');
    borderEvents.emit('enqueued', peering.alias);
    written.push({ alias: peering.alias, id });
  }
  return written;
}

/**
 * F4 §15 note 1 — the ONE call site of `enqueueOutboundTopicRows`.
 *
 * Two paths publish a home topic: a local agent publishing it, and the hub
 * re-originating a spoke's `topic-publish`. Both go through here, so "exactly
 * one call site" survives having two callers — and the mutant that moves the
 * enqueue into `fanOutTopicLocal` (which the `topic` DELIVERY arm also calls)
 * still reds, because that arm would then re-originate.
 */
function fanOutHomeTopicPublish(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  m: Parameters<typeof fanOutTopicLocal>[2],
): { alias: string; id: string }[] {
  fanOutTopicLocal(db, agentIndex, m);
  return enqueueOutboundTopicRows(db, {
    topic: m.topic,
    origin: m.origin,
    payload: m.payload,
    content_type: m.content_type,
    sent_at: m.sent_at,
    expires_at: m.expires_at,
  });
}

/**
 * The audience for a frame that crosses a border (F3).
 *
 * The `observerIndex.size === 0` short-circuit is why this is a helper and not
 * an inline call: with no observers connected there is nobody the query could
 * inform, so the common case pays nothing on the relay path. The query is only
 * reached when an observer is actually connected.
 */
function crossBorderAudience(db: Database, observerIndex: Map<string, WebSocket>): TapAudience {
  return {
    crossBorder: true,
    scoped: observerIndex.size === 0 ? NO_OBSERVERS : listCrossBorderObservers(db),
  };
}

export function routeRelay(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  peer: Peer,
  frame: RelayFrameIn,
  observerIndex: Map<string, WebSocket> = new Map()
): { ok: true } | { ok: false; code: 'RELAY_REFUSED' | 'RATE_LIMITED'; ref?: string } {
  const alias = peer.alias;
  const ref = typeof frame.msg_id === 'string' && frame.msg_id.length > 0 ? frame.msg_id : undefined;
  const refuse = (reason: string) => {
    incPeerRelay(alias, 'in', 'refused');
    console.log(JSON.stringify({ evt: 'peer.relay_refused', alias, reason, at: Date.now() }));
    return { ok: false as const, code: 'RELAY_REFUSED' as const, ...(ref !== undefined ? { ref } : {}) };
  };

  // ── Validation. Shape first, so a malformed frame never reaches a lookup.
  //
  // F4 restructures this: the KIND is dispatched on before the `to` check,
  // because `to` is required for `direct` and must be ABSENT for every topic
  // kind — a topic frame names a topic, and a `to` on one would be a second,
  // contradictory address.
  const { msg_id, from, payload, kind } = frame;
  const to = frame.to;
  if (typeof msg_id !== 'string' || msg_id.length === 0) return refuse('bad_msg_id');
  if (typeof from !== 'string' || from.length === 0) return refuse('bad_from');

  const TOPIC_KINDS = ['topic', 'topic-subscribe', 'topic-unsubscribe', 'topic-publish'];
  if (kind !== 'direct' && !TOPIC_KINDS.includes(kind as string)) return refuse('bad_kind');
  const isTopicKind = kind !== 'direct';

  if (isTopicKind) {
    if (to !== undefined) return refuse('to_not_permitted');
  } else {
    if (typeof to !== 'string' || to.length === 0) return refuse('bad_to');
  }

  // `payload` is required for the kinds that carry one. Subscribe and
  // unsubscribe carry none: they are state changes, not messages.
  const carriesPayload = kind === 'direct' || kind === 'topic' || kind === 'topic-publish';
  if (carriesPayload && typeof payload !== 'string') return refuse('bad_payload');

  // The topic name, on every topic kind. Bare and bounded for the same reason
  // `from` is: a ':' here would name a topic on a THIRD mesh.
  let topicName = '';
  if (isTopicKind) {
    const t = frame.topic;
    if (typeof t !== 'string' || t.length === 0) return refuse('bad_topic');
    if (Buffer.byteLength(t, 'utf8') > 256 || t.includes(':')) return refuse('bad_topic');
    topicName = t;
  }

  // `origin` is ATTACKER-SUPPLIED and display-only: shape-checked here and then
  // carried verbatim. It is never routed on and never an ACL principal, so the
  // only thing that can go wrong with it is size.
  if (frame.origin !== undefined) {
    if (typeof frame.origin !== 'string' || Buffer.byteLength(frame.origin, 'utf8') > 256) {
      return refuse('bad_origin');
    }
  }
  const origin = typeof frame.origin === 'string' ? frame.origin : null;

  // ONE HOP. `from`/`to` must be bare — a ':' would mean this peer is relaying
  // on behalf of a THIRD mesh, which is transitive federation nobody agreed to:
  // our admin's border decision covers this peer, not that peer's peers.
  if (Buffer.byteLength(from, 'utf8') > 256 || from.includes(':')) return refuse('from_not_one_hop');
  if (!isTopicKind && (Buffer.byteLength(to as string, 'utf8') > 256 || (to as string).includes(':'))) {
    return refuse('to_not_one_hop');
  }

  const payloadBytes = carriesPayload ? Buffer.byteLength(payload as string, 'utf8') : 0;
  if (payloadBytes > 1_048_576) return refuse('too_large');

  // ── Peer state, then rate, then border, then dedupe. Order matters: the rate
  // bucket counts BEFORE the cheaper checks so a peer cannot probe for free.
  // A relay arriving on a still-open socket of a DISABLED peer — the window
  // before the sweep closes it, or before a revoke-close lands. The refusal is
  // the SAME RELAY_REFUSED bytes as every other: not a distinct code (that
  // would tell a revoked peer it was revoked, #104's lesson at the relay
  // layer), and not a close from here — closing is the sweep's and the
  // revoke path's job, and doing it in two places means two things that can
  // disagree about when a socket dies.
  if (peer.disabled === 1) return refuse('peer_disabled');

  const now = Date.now();
  if (!withinRate(alias, peer.rate_per_min, now)) {
    incPeerRelay(alias, 'in', 'rate_limited');
    return { ok: false, code: 'RATE_LIMITED', ...(ref !== undefined ? { ref } : {}) };
  }

  // The border its admin set, read from `peers` (copied there at registration)
  // and never from peer_keys — the key may have been re-minted since.
  let allowedKinds: string[];
  try { allowedKinds = JSON.parse(peer.kinds) as string[]; } catch { return refuse('bad_kinds_column'); }
  if (!Array.isArray(allowedKinds)) return refuse('bad_kinds_column');
  // §16 E: `topic-unsubscribe` skips ONLY this test — teardown is always
  // allowed, because a peer that may not stop subscribing is worse than one
  // that may. The JSON parse above still runs and still refuses a malformed
  // column, so a broken row does not quietly become permissive for one kind.
  if (kind !== 'topic-unsubscribe' && !allowedKinds.includes(kind as string)) return refuse('kind_not_permitted');

  // ── Dedupe on the REMOTE id, within RELAY_DEDUPE_MS. A repeat inside the
  // window is re-ACKed and delivered NOTHING: the peer's retry after a lost ack
  // must be safe. After the window the row is swept and the same id is a NEW
  // message BY DESIGN — a dedupe ledger that grew forever is the alternative.
  const seen = db.prepare('SELECT 1 FROM relays WHERE peer_alias = ? AND remote_msg_id = ?').get(alias, msg_id);
  if (seen !== null) {
    incPeerRelay(alias, 'in', 'duplicate');
    return { ok: true };
  }

  const stampedFrom = isTopicKind ? `${alias}:${topicName}` : `${alias}:${from}`;

  // (b) A peer's ttl is untrusted input. Negative is malformed; enormous
  // promises storage past the dedupe window, which is never honoured.
  const rawTtl = typeof frame.ttl_ms === 'number' ? frame.ttl_ms : 300_000;
  if (!Number.isFinite(rawTtl) || rawTtl < 0) return refuse('bad_ttl');
  const ttl = Math.min(rawTtl, MAX_TTL_MS);
  const content_type = typeof frame.content_type === 'string' ? frame.content_type : 'text/plain';

  // ── The SUBSCRIBE arms: state changes from a mesh whose agents want, or no
  // longer want, one of OUR topics.
  //
  // THE SAME-ALIAS RETURN RULE (A3). `peers` and `outbound_peers` share no
  // column, so the only way to know where this topic would be DELIVERED is to
  // look for an outbound peering under the same alias. Without one — or with
  // one that cannot carry `topic` — a subscription would be recorded that can
  // never be served, which is worse than a refusal because nothing reports it.
  //
  // NO `getOrCreateTopic`: a remote caller never creates a topic here. A
  // subscribe to a name this mesh does not own is refused, or any peer could
  // populate our topics table one guess at a time.
  if (kind === 'topic-subscribe' || kind === 'topic-unsubscribe') {
    db.prepare('INSERT INTO relays (peer_alias, remote_msg_id, seen_at) VALUES (?, ?, ?)')
      .run(alias, msg_id, now);
    const remoteSubscriber = `${alias}:${from}`;

    if (kind === 'topic-unsubscribe') {
      // Teardown asks nothing of the return peering or the topic: whatever the
      // state is, less of it is always allowed.
      unsubscribeRemoved(db, remoteSubscriber, topicName);
      incPeerRelay(alias, 'in', 'delivered');
      return { ok: true };
    }

    const returnPeering = getOutboundPeer(db, alias);
    if (returnPeering === null || returnPeering.enabled !== 1) return refuse('no_return_peering');
    let returnKinds: string[];
    try { returnKinds = JSON.parse(returnPeering.kinds) as string[]; } catch { return refuse('no_return_peering'); }
    if (!Array.isArray(returnKinds) || !returnKinds.includes('topic')) return refuse('no_return_peering');

    if (!isHomeTopic(db, topicName)) return refuse('not_home_topic');

    subscribeCreated(db, remoteSubscriber, topicName);
    incPeerRelay(alias, 'in', 'delivered');
    return { ok: true };
  }

  // ── The POST arm: a spoke asking us, the OWNER, to publish.
  //
  // We re-originate: the post becomes ours, `from_agent` is the topic
  // principal, and `origin` records who really said it — for display only. The
  // hub is the ordering authority, which is why the poster's own mesh hears it
  // as an echo of OUR delivery rather than of its own send.
  if (kind === 'topic-publish') {
    if (!isHomeTopic(db, topicName)) return refuse('not_home_topic');
    // THE RIGHT TO POST, held by the remote publisher against our topic.
    if (!aclCheck(db, `${alias}:${from}`, `${TOPIC_PRINCIPAL_PREFIX}${topicName}`)) return refuse('no_post_edge');

    db.prepare('INSERT INTO relays (peer_alias, remote_msg_id, seen_at) VALUES (?, ?, ?)')
      .run(alias, msg_id, now);

    const principal = `${TOPIC_PRINCIPAL_PREFIX}${topicName}`;
    fanOutHomeTopicPublish(db, agentIndex, {
      topic: topicName,
      from_agent: principal,
      // THE TOPIC, not the poster: a subscriber's right to hear is a property
      // of the topic. A hub subscriber holds `topic:x → me` and nothing from
      // whoever posted on the far side.
      aclPrincipal: principal,
      origin: `${alias}:${from}`,
      payload: payload as string,
      content_type,
      // THIS FRAME's budget, clamped — never a default. A spoke's short-lived
      // post must not outlive its sender's intent on the way through.
      sent_at: now,
      expires_at: ttl === 0 ? null : now + ttl,
      ephemeral: ttl === 0,
      payloadBytes,
    });

    emitTap(observerIndex, {
      type: 'tap', msg_id, kind: 'topic',
      from: `${alias}:${from}`, to: null, topic: topicName, correlation_id: null,
      sent_at: now, size: payloadBytes, payload: payload as string,
    }, crossBorderAudience(db, observerIndex));

    incPeerRelay(alias, 'in', 'delivered');
    return { ok: true };
  }

  // ── The TOPIC arm: a delivery from the mesh that OWNS the topic.
  //
  // The topic is stamped with our alias for them — `orch:trollbox` — which is
  // the same convention that makes a relayed sender `orch:alice`, so a local
  // agent can never be confused for a remote principal. The stamped name is
  // also the ACL principal: on this mesh, the right to hear this topic is a
  // property of the topic, not of whoever posted on the far side.
  //
  // AND NOTHING ELSE. No enqueue, so a delivery is never re-originated: a post
  // crosses at most two borders and only through its home mesh. That is
  // structural — the enqueue has one call site and it is not reachable from
  // here — rather than a rule someone has to remember.
  if (kind === 'topic') {
    const localTopicId = crypto.randomUUID();
    db.prepare('INSERT INTO relays (peer_alias, remote_msg_id, seen_at) VALUES (?, ?, ?)')
      .run(alias, msg_id, now);

    fanOutTopicLocal(db, agentIndex, {
      topic: stampedFrom,
      from_agent: stampedFrom,
      aclPrincipal: stampedFrom,
      origin,
      payload: payload as string,
      content_type,
      sent_at: now,
      expires_at: ttl === 0 ? null : now + ttl,
      ephemeral: ttl === 0,
      payloadBytes,
    });

    // ONE tap per BORDER FRAME, not per fanned-out copy: what crossed the
    // border is one frame, and an observer counting deliveries would otherwise
    // see this mesh's subscriber count leak into the cross-border stream.
    emitTap(observerIndex, {
      type: 'tap', msg_id: localTopicId, kind: 'topic',
      from: stampedFrom, to: null, topic: stampedFrom, correlation_id: null,
      sent_at: now, size: payloadBytes, payload: payload as string,
    }, crossBorderAudience(db, observerIndex));

    // 'delivered' means ACCEPTED AT THE BORDER, even when the local fan-out
    // filtered every subscriber: the peering did its job, and what this mesh
    // then chose to do with the frame is its own ACL's business, counted by
    // mesh_topic_fanout_total.
    incPeerRelay(alias, 'in', 'delivered');
    return { ok: true };
  }

  // ── Recipient and the inbound edge. Both answer the same RELAY_REFUSED.
  if (getAgentById(db, to as string) === null) return refuse('to_unknown');
  if (!aclCheck(db, stampedFrom, to as string)) return refuse('no_edge');

  // ── Accept. A LOCAL id for messages.id: the remote id is the peer's
  // namespace and could collide with one of ours, so it lives only in `relays`.
  const localId = crypto.randomUUID();
  db.prepare('INSERT INTO relays (peer_alias, remote_msg_id, seen_at) VALUES (?, ?, ?)')
    .run(alias, msg_id, now);

  deliverOrQueue(db, agentIndex, {
    id: localId,
    from_agent: stampedFrom,
    to_agent: to as string,
    payload: payload as string,
    content_type,
    sent_at: now,
    expires_at: ttl === 0 ? null : now + ttl,
    ephemeral: ttl === 0,
    payloadBytes,
  });

  // CROSS-BORDER (inbound): `from` is a remote id stamped with the peer alias.
  emitTap(observerIndex, {
    type: 'tap', msg_id: localId, kind: 'direct',
    from: stampedFrom, to: to as string, topic: null, correlation_id: null,
    sent_at: now, size: payloadBytes, payload: payload as string,
  }, crossBorderAudience(db, observerIndex));

  incPeerRelay(alias, 'in', 'delivered');
  return { ok: true };
}

export function routeDirect(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: SendFrame,
  observerIndex: Map<string, WebSocket> = new Map()
): RouterResult {
  // 1. Payload size check
  const payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
  if (payloadBytes > 1_048_576) {
    incError('MESSAGE_TOO_LARGE');
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  // 1b. REMOTE BRANCH (F2a, §5.3) — before the local recipient lookup.
  //
  // C9 note, per door: every refusal below answers ONE question — "may this
  // message go to that remote?" — and every one of them is AGENT_NOT_FOUND with
  // the same bytes as an unknown LOCAL id. A local sender must not be able to
  // tell "that mesh is not peered", "that address is malformed", "no edge" or
  // "no such local agent" apart; distinguishing them would let any agent map
  // this mesh's peerings and ACL from the outside.
  //
  // KIND_NOT_ALLOWED is the deliberate exception, and the justification is
  // REACHABILITY, not content (#123): it is emitted only AFTER the ACL check,
  // so only a caller that already holds an edge to this peering can ever see
  // it — and such a caller already knows the peering exists. Before the ACL
  // check the same message was an enumeration oracle for the topology.
  //
  // The lesson is that an exemption from uniformity is a property of WHO CAN
  // REACH the refusal, never of what the refusal says.
  //
  // TABLES READ: outbound_peers (via hasOutboundPeer) and agents (the local
  // lookup below). The union is total for "where does this address point?"
  // because an id either names a live outbound peering or it does not, and if
  // it does not it can only be a local id — legacy colon ids included, which is
  // why the fall-through is UNCHANGED rather than an error.
  const colon = frame.to.indexOf(':');
  if (colon > 0) {
    const alias = frame.to.slice(0, colon);
    if (hasOutboundPeer(db, alias)) {
      const remainder = frame.to.slice(colon + 1);

      // One hop. A second ':' would address a mesh THROUGH a mesh — transitive
      // federation our admin never agreed to. Refused here rather than wasting
      // a relay the far side would refuse anyway.
      if (remainder.length === 0 || remainder.includes(':')) {
        incError('AGENT_NOT_FOUND');
        return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
      }

      // ACL FIRST, THEN KIND — the order is the security property (#123).
      //
      // Reversed, KIND_NOT_ALLOWED is emitted before anyone checks whether the
      // caller may address this peering at all, so an agent with NO edge learns
      // that the peering EXISTS by sending a wrong-kind message. There is no
      // other route to that topology from inside. Reproduced:
      //   peering EXISTS -> KIND_NOT_ALLOWED (and it named the alias)
      //   peering ABSENT -> AGENT_NOT_FOUND
      //
      // Behind the ACL check, the exemption is justified by REACHABILITY rather
      // than by content: a caller holding an edge to alias:x already knows that
      // peering exists, so telling it about a kind reveals nothing it could not
      // already determine. A caller without one sees the uniform
      // AGENT_NOT_FOUND for no-peering, no-edge and wrong-kind alike.
      if (!aclCheck(db, from_agent, frame.to)) {
        incError('AGENT_NOT_FOUND');
        return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
      }

      const peering = getOutboundPeer(db, alias)!;
      let outboundKinds: string[];
      try { outboundKinds = JSON.parse(peering.kinds) as string[]; } catch { outboundKinds = []; }
      if (!outboundKinds.includes('direct')) {
        incError('KIND_NOT_ALLOWED');
        return { ok: false, error_code: 'KIND_NOT_ALLOWED', error_message: `kind not permitted to ${alias}` };
      }

      // #94's duplicate check in the SAME position as the local path: above the
      // metrics, which are the first side effect (#96 pins that ordering).
      if (getMessage(db, frame.msg_id) !== null) {
        incError('DUPLICATE_MSG_ID');
        return { ok: false, error_code: 'DUPLICATE_MSG_ID', error_message: `msg_id already used: ${frame.msg_id}` };
      }

      incSent(from_agent);
      incBytes('in', payloadBytes);
      observePayloadBytes(payloadBytes);

      // (b) Same clamp on the sending side. A local agent asking for a
      // year-long ttl to a remote id would otherwise queue a row the forwarder
      // expires at 7 days anyway — a promise the system does not keep.
      const rawTtlRemote = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
      if (!Number.isFinite(rawTtlRemote) || rawTtlRemote < 0) {
        incError('AGENT_NOT_FOUND');
        return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
      }
      const ttlRemote = Math.min(rawTtlRemote, MAX_TTL_MS);
      const sentAtRemote = Date.now();

      // ttl_ms = 0 keeps its LOCAL meaning: deliver live or drop, never queue.
      // "Online" for a remote id means the peering's socket is connected, which
      // only the forwarder knows — so F2a drops it rather than storing a row no
      // ttl-0 sender expects to exist. F2b relays it live when connected.
      if (ttlRemote === 0) {
        incMsgStatus('direct', 'dropped');
        return { ok: true, msg_id: frame.msg_id };
      }

      insertMessage(db, {
        id: frame.msg_id,
        kind: 'direct',
        from_agent,
        to_agent: frame.to,          // the FQ remote id; the forwarder ranges on it
        payload: frame.payload,
        content_type: frame.content_type ?? 'text/plain',
        sent_at: sentAtRemote,
        expires_at: sentAtRemote + ttlRemote,
      });
      incMsgStatus('direct', 'queued');

      // CROSS-BORDER (outbound): `to` is a remote id (alias:agent).
      emitTap(observerIndex, {
        type: 'tap', msg_id: frame.msg_id, kind: 'direct',
        from: from_agent, to: frame.to, topic: null, correlation_id: null,
        sent_at: sentAtRemote, size: payloadBytes, payload: frame.payload,
      }, crossBorderAudience(db, observerIndex));

      // ACK THE LOCAL SENDER NOW (D8): acceptance means "queued for the border",
      // not "delivered to the far mesh". The forwarder reports the real outcome
      // later via delivered_at, or failed_code + REMOTE_REFUSED.
      //
      // The emit is AFTER the synchronous section and is never awaited — an
      // await between the duplicate check and the insert lets two frames
      // interleave, both pass, and the second insert throw.
      borderEvents.emit('enqueued', alias);

      return { ok: true, msg_id: frame.msg_id };
    }
    // Not a live outbound peering: fall through to the local lookup UNCHANGED.
    // A legacy colon id is a local agent (#113/§5.4) and must keep working, and
    // an unknown alias gets the same AGENT_NOT_FOUND as any unknown local id.
  }

  // 2. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    incError('AGENT_NOT_FOUND');
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 3. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    incError('ACL_DENIED');
    incAclDenied(from_agent);
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
  }

  // 3b. Duplicate msg_id (#94). frame.msg_id becomes messages.id, the PRIMARY
  // KEY, so a repeat raises UNIQUE constraint failed — which, before the
  // dispatcher guard, escaped as an uncaught exception and killed the process.
  // An honest SDK retry after a lost ack is enough to do it.
  //
  // Checked HERE rather than by catching the UNIQUE constraint at the insert,
  // for two reasons — neither of which is "the recipient would already have
  // been handed the frame". An earlier version of this comment claimed that,
  // and it was WRONG: insertMessage runs BEFORE recipientWs.send on the online
  // path, so a catch-based fix would in fact refuse before any delivery. The
  // real reasons:
  //
  //   1. A caught constraint has to be identified by matching SQLite's error
  //      text, which would also swallow a UNIQUE violation from any OTHER
  //      column or index and misreport it as a duplicate msg_id. Refusing on an
  //      explicit lookup says exactly what was wrong and nothing else.
  //   2. It refuses before the accepted-and-routed metrics below (incSent,
  //      incBytes, observePayloadBytes), so a rejected duplicate is not counted
  //      as traffic the bus carried.
  //
  // Checked against the stored row, so ttl_ms=0 is unaffected: an ephemeral
  // send persists nothing, has no id to collide with, and stays repeatable.
  // Reusing an id that DOES identify a stored message is refused, since that
  // is precisely the ambiguity the primary key exists to prevent.
  if (getMessage(db, frame.msg_id) !== null) {
    incError('DUPLICATE_MSG_ID');
    return {
      ok: false,
      error_code: 'DUPLICATE_MSG_ID',
      error_message: `msg_id already used: ${frame.msg_id}`,
    };
  }

  // accepted+routed
  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 4. Compute expires_at
  const ttl = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 5/6. Deliver or queue. Extracted (F1b) so the relay handler reuses this
  // EXACT path rather than a second copy of it — two implementations of
  // "deliver if online, queue if not, honour ttl 0" would drift, and the drift
  // would be invisible until a federated message behaved differently from a
  // local one.
  deliverOrQueue(db, agentIndex, {
    id: frame.msg_id,
    from_agent,
    to_agent: frame.to,
    payload: frame.payload,
    content_type,
    sent_at,
    expires_at,
    ephemeral: ttl === 0,
    payloadBytes,
  });

  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'direct',
    from: from_agent, to: frame.to, topic: null, correlation_id: null,
    sent_at, size: payloadBytes, payload: frame.payload,
  }, LOCAL_ONLY);

  return { ok: true, msg_id: frame.msg_id };
}

export function drainQueue(
  db: Database,
  agentId: string,
  ws: WebSocket
): number {
  const pending = getPendingMessages(db, agentId);
  for (const msg of pending) {
    ws.send(buildDeliverFrame(msg));
    markDelivered(db, msg.id);
    incMsgStatus(msg.kind, 'delivered');
    incReceived(agentId);
    incBytes('out', Buffer.byteLength(msg.payload, 'utf8'));
  }
  return pending.length;
}

export function routePublish(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: PublishFrame,
  observerIndex: Map<string, WebSocket> = new Map()
): RouterResult {
  // 1. Payload size check
  const payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
  if (payloadBytes > 1_048_576) {
    incError('MESSAGE_TOO_LARGE');
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  // 1b. REMOTE TOPIC (§16 D). Placed before the local counters, and counting
  //     inside the branch only AFTER every refusal has passed — mirroring
  //     routeDirect, where a refused remote send counts nothing. A refusal is
  //     not traffic.
  const topicColon = frame.topic.indexOf(':');
  if (topicColon > 0 && hasOutboundPeer(db, frame.topic.slice(0, topicColon))) {
    const alias = frame.topic.slice(0, topicColon);
    const remote = frame.topic.slice(topicColon + 1);
    const refuseRemote = (): RouterResult => {
      incError('AGENT_NOT_FOUND');
      return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown topic: ${frame.topic}` };
    };
    if (remote.length === 0 || remote.includes(':') || Buffer.byteLength(remote, 'utf8') > 256) return refuseRemote();

    // THE RIGHT TO POST, held by the publisher against the topic as an
    // endpoint. The SENDING mesh decides whether this topic may leave.
    if (!aclCheck(db, from_agent, frame.topic)) return refuseRemote();

    // The one non-uniform code on this path, and it sits BEHIND the ACL —
    // which is what makes it affordable: a caller that reaches it has already
    // proven an edge to this topic, so the answer reveals only its OWN mesh's
    // configuration and crosses no border (#123).
    const peering = getOutboundPeer(db, alias);
    let kinds: string[];
    try { kinds = JSON.parse(peering!.kinds) as string[]; } catch { return refuseRemote(); }
    if (!Array.isArray(kinds) || !kinds.includes('topic-publish')) {
      incError('KIND_NOT_ALLOWED');
      return { ok: false, error_code: 'KIND_NOT_ALLOWED', error_message: `kind not permitted to ${alias}` };
    }

    incSent(from_agent);
    incBytes('in', payloadBytes);
    observePayloadBytes(payloadBytes);

    const nowRemote = Date.now();
    const rawTtlPub = frame.ttl_ms === 0 ? 0 : (frame.ttl_ms ?? 300_000);
    const ttlPub = Math.min(rawTtlPub, MAX_TTL_MS);
    const postId = crypto.randomUUID();
    insertMessage(db, {
      id: postId,
      kind: 'topic-publish',
      from_agent,                       // bare; the hub stamps it with its alias for us
      to_agent: `${alias}:`,
      topic: remote,
      payload: frame.payload,
      content_type: frame.content_type ?? 'text/plain',
      sent_at: nowRemote,
      expires_at: ttlPub === 0 ? null : nowRemote + ttlPub,
    });
    incMsgStatus('topic', 'queued');

    emitTap(observerIndex, {
      type: 'tap', msg_id: postId, kind: 'topic',
      from: from_agent, to: null, topic: frame.topic, correlation_id: null,
      sent_at: nowRemote, size: payloadBytes, payload: frame.payload,
    }, crossBorderAudience(db, observerIndex));

    borderEvents.emit('enqueued', alias);

    // NO LOCAL FAN-OUT (C7). Local subscribers hear this when the hub's
    // delivery returns — the hub is the ordering authority, and a local
    // shortcut would show this mesh's own agents a different order from every
    // other mesh's.
    return { ok: true, msg_id: frame.msg_id };
  }

  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 2. Ensure topic exists. A NEW name still has to be a permissible one.
  const publishNameRefusal = topicNameRefusal(db, frame.topic);
  if (publishNameRefusal !== null) {
    incError('AGENT_NOT_FOUND');
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown topic: ${frame.topic}` };
  }
  getOrCreateTopic(db, frame.topic, from_agent);

  // 4. Compute expires_at
  let ttl: number;
  if (frame.ttl_ms === 0) {
    ttl = 0;
  } else {
    ttl = frame.ttl_ms ?? 300_000;
  }
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 5. Fan out locally AND across every peering that may carry this topic.
  //    The hub is the ordering authority for a topic it owns.
  const outbound = fanOutHomeTopicPublish(db, agentIndex, {
    topic: frame.topic,
    from_agent,
    // The hub is the origin of its own post: the publisher's bare id, so a
    // spoke can show who said it.
    origin: from_agent,
    aclPrincipal: from_agent,
    payload: frame.payload,
    content_type,
    sent_at,
    expires_at,
    ephemeral: ttl === 0,
    payloadBytes,
  });

  // One CROSS-BORDER tap per outbound row, beside the LOCAL_ONLY tap below.
  // Emitted here rather than inside the enqueue, so the set of tap-emitting
  // router functions stays exactly what observer-cross-border.test.ts drives.
  for (const row of outbound) {
    emitTap(observerIndex, {
      type: 'tap', msg_id: row.id, kind: 'topic',
      from: `${TOPIC_PRINCIPAL_PREFIX}${frame.topic}`, to: null,
      topic: frame.topic, correlation_id: null,
      sent_at, size: payloadBytes, payload: frame.payload,
    }, crossBorderAudience(db, observerIndex));
  }
  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'topic',
    from: from_agent, to: null, topic: frame.topic, correlation_id: null,
    sent_at, size: payloadBytes, payload: frame.payload,
  }, LOCAL_ONLY);

  return { ok: true, msg_id: frame.msg_id };
}

/**
 * F4 §6, §7 — subscribe, local or across a border.
 *
 * ONE REFUSAL FOR EVERY CAUSE: `AGENT_NOT_FOUND` with `unknown topic: <what
 * you asked for>`. There is deliberately no `KIND_NOT_ALLOWED` here, unlike
 * the publish path — this door has NO ACL gate in front of it, so any
 * authenticated agent could walk it, and a distinct code would hand them a
 * free map of which aliases are peered and with which kinds. On the publish
 * path the distinct code sits BEHIND an ACL check, which is what makes it
 * affordable there (#123).
 *
 * The remote branch is tried FIRST, mirroring `routeDirect`: a prefix that
 * names a live outbound peering means the caller is addressing another mesh.
 * A prefix that names nothing falls through to the local path, where the
 * new-name rule refuses it — so `ghost:trollbox` and `orch:` and `orch:a:b`
 * all end at the same bytes by different routes.
 */
export function routeSubscribe(
  db: Database,
  agent_id: string,
  frame: SubscribeFrame
): RouterResult {
  const refuse = (): RouterResult => {
    incError('AGENT_NOT_FOUND');
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown topic: ${frame.topic}` };
  };

  const colon = frame.topic.indexOf(':');
  if (colon > 0 && hasOutboundPeer(db, frame.topic.slice(0, colon))) {
    const alias = frame.topic.slice(0, colon);
    const remote = frame.topic.slice(colon + 1);
    // Bare and bounded: a second ':' would name a topic on a THIRD mesh, which
    // is transitive federation nobody agreed to.
    if (remote.length === 0 || remote.includes(':') || Buffer.byteLength(remote, 'utf8') > 256) return refuse();

    const peering = getOutboundPeer(db, alias);
    let kinds: string[];
    try { kinds = JSON.parse(peering!.kinds) as string[]; } catch { return refuse(); }
    if (!Array.isArray(kinds) || !kinds.includes('topic-subscribe')) return refuse();

    // The local topics row carries the FULL remote name, and `created_by` is a
    // local agent so the foreign key is satisfied. That row is what the
    // subscription points at — and why home-ness is a PREFIX test rather than
    // row existence.
    getOrCreateTopic(db, frame.topic, agent_id);

    // GATED ON A REAL STATE CHANGE. The SDK replays every subscription on
    // reconnect, and a border row per replay would burn the peering's rate
    // bucket to say nothing.
    if (subscribeCreated(db, agent_id, frame.topic)) {
      const now = Date.now();
      insertMessage(db, {
        id: crypto.randomUUID(),
        kind: 'topic-subscribe',
        from_agent: agent_id,          // bare; the hub stamps it with our alias
        to_agent: `${alias}:`,
        topic: remote,
        payload: '',
        sent_at: now,
        // The DEDUPE window, not the message default: subscription state is not
        // time-sensitive traffic and must survive a peering outage. A longer
        // wait is diagnosed with GET /peers/:alias/subscriptions.
        expires_at: now + MAX_TTL_MS,
      });
      borderEvents.emit('enqueued', alias);
    }
    return { ok: true };
  }

  // Local. A NEW name still has to be a permissible one.
  const nameRefusal = topicNameRefusal(db, frame.topic);
  if (nameRefusal !== null) return refuse();

  getOrCreateTopic(db, frame.topic, agent_id);
  dbSubscribe(db, agent_id, frame.topic);
  return { ok: true };
}

export function routeUnsubscribe(
  db: Database,
  agent_id: string,
  frame: UnsubscribeFrame
): RouterResult {
  // #129: NO TOPIC-EXISTENCE CHECK. Unsubscribe is idempotent and always
  // succeeds — including for a topic that does not exist, and for one the
  // caller was never subscribed to.
  //
  // The deleted check was an ENUMERATION ORACLE, and one that C9's own
  // detection method could not see. `listTopics` is admin-only (http-admin.ts),
  // `routeSubscribe` and `routePublish` both getOrCreateTopic and so never
  // refuse on absence: this was the ONLY topic-existence refusal an agent
  // socket could reach. The system withholds the topic list from agents, which
  // makes existence confidential, so a per-guess `TOPIC_NOT_FOUND` vs `ok`
  // handed any authenticated agent the whole namespace, one probe at a time,
  // with no subscription and no trace.
  //
  // Note the SHAPE, because it is why a uniform-refusal review missed it: the
  // discriminator was a refusal versus a SUCCESS. Driving every reachable
  // refusal cause at this door and asserting identical bytes passes while the
  // oracle stays wide open, since the leaking outcome was never a refusal.
  //
  // Deleting the check loses nothing real: dbUnsubscribe is already an
  // unconditional DELETE scoped by agent_id, so the refusal never protected
  // any state — it only reported. Idempotent unsubscribe is also the honest
  // contract for a caller retrying after a lost ack.
  //
  // F4: teardown crosses the border when there WAS something to tear down. It
  // is enqueued regardless of the peering's `kinds` — a peer that may not stop
  // subscribing is worse than one that may, and the receiving side skips the
  // kind check for this one frame for the same reason (§16 E).
  const removed = unsubscribeRemoved(db, agent_id, frame.topic);
  const colon = frame.topic.indexOf(':');
  if (removed && colon > 0 && hasOutboundPeer(db, frame.topic.slice(0, colon))) {
    const alias = frame.topic.slice(0, colon);
    const now = Date.now();
    insertMessage(db, {
      id: crypto.randomUUID(),
      kind: 'topic-unsubscribe',
      from_agent: agent_id,
      to_agent: `${alias}:`,
      topic: frame.topic.slice(colon + 1),
      payload: '',
      sent_at: now,
      expires_at: now + MAX_TTL_MS,
    });
    borderEvents.emit('enqueued', alias);
  }
  return { ok: true };
}

// ──────────────────────────────────────────────
// Sprint 9: File Transfer
// (FileSendFrame wire type is imported from the shared client protocol module above.)
// ──────────────────────────────────────────────

export function routeFile(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: FileSendFrame,
  maxFileBytes: number,
  filesDir: string,
  observerIndex: Map<string, WebSocket> = new Map()
): RouterResult {
  // 1. Validate base64 — attempt decode and check round-trip
  let decoded: Buffer;
  try {
    decoded = Buffer.from(frame.data, 'base64');
    // Round-trip check: re-encoding must match original (no garbage accepted)
    if (decoded.toString('base64') !== frame.data) {
      incError('INVALID_BASE64');
      return { ok: false, error_code: 'INVALID_BASE64', error_message: 'data is not valid base64' };
    }
  } catch {
    incError('INVALID_BASE64');
    return { ok: false, error_code: 'INVALID_BASE64', error_message: 'data is not valid base64' };
  }

  // 2. Check decoded byte count
  if (decoded.byteLength > maxFileBytes) {
    incError('FILE_TOO_LARGE');
    return { ok: false, error_code: 'FILE_TOO_LARGE', error_message: `file exceeds ${maxFileBytes} byte limit` };
  }

  // 3. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    incError('AGENT_NOT_FOUND');
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 4. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    incError('ACL_DENIED');
    incAclDenied(from_agent);
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
  }

  // 4b. Caption size validation
  if (frame.caption !== undefined && Buffer.byteLength(frame.caption, 'utf8') > 4096) {
    incError('CAPTION_TOO_LARGE');
    return { ok: false, error_code: 'CAPTION_TOO_LARGE', error_message: 'caption exceeds 4096 byte limit' };
  }

  // 5. Generate file_id
  const file_id = crypto.randomUUID();

  // 6. Compute expires_at (same logic as routeDirect: 0 -> null, default 300_000)
  const ttl = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'application/octet-stream';
  const size_bytes = decoded.byteLength;
  const sent_at = Date.now();

  // 7. If recipient offline and ttl_ms === 0: discard entirely
  const recipientWs = agentIndex.get(frame.to);
  if (recipientWs === undefined && ttl === 0) {
    incMsgStatus('file', 'dropped');
    return { ok: true, msg_id: frame.msg_id };
  }

  // 8. Write file to disk
  const filePath = join(filesDir, file_id);
  writeFileSync(filePath, decoded);

  // 9. Store metadata in DB
  insertFile(db, {
    id: file_id,
    from_agent,
    to_agent: frame.to,
    filename: frame.filename,
    content_type,
    size_bytes,
    file_path: filePath,
    sent_at,
    expires_at,
    caption: frame.caption ?? null,
    reply_to_msg_id: frame.reply_to_msg_id ?? null,
    group_id: frame.group_id ?? null,
  });
  incFile();
  incSent(from_agent);

  // 9. Deliver if recipient online
  if (recipientWs !== undefined) {
    const deliverFrame = JSON.stringify({
      type: 'file_deliver',
      file_id,
      from: from_agent,
      to: frame.to,
      filename: frame.filename,
      content_type,
      size_bytes,
      sent_at,
      fetch_url: `/files/${file_id}`,
      caption: frame.caption ?? null,
      reply_to_msg_id: frame.reply_to_msg_id ?? null,
      group_id: frame.group_id ?? null,
    });
    recipientWs.send(deliverFrame);
    markFileDelivered(db, file_id);
    incMsgStatus('file', 'delivered');
    incReceived(frame.to);
  }
  if (recipientWs === undefined) {
    incMsgStatus('file', 'queued');
  }

  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'file',
    from: from_agent, to: frame.to, topic: null, correlation_id: null,
    sent_at, size: size_bytes, payload: null,
    file_id, filename: frame.filename, content_type,
  }, LOCAL_ONLY);

  return { ok: true, msg_id: frame.msg_id, fileId: file_id };
}

export function drainFileQueue(
  db: Database,
  agentId: string,
  ws: WebSocket
): number {
  const now = Date.now();
  const pendingFiles = db.prepare(`
    SELECT id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id, group_id FROM files
    WHERE to_agent = ?
      AND delivered_at IS NULL
      AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY sent_at ASC
  `).all(agentId, now) as FileRecord[];

  for (const file of pendingFiles) {
    const deliverFrame = JSON.stringify({
      type: 'file_deliver',
      file_id: file.id,
      from: file.from_agent,
      to: file.to_agent,
      filename: file.filename,
      content_type: file.content_type,
      size_bytes: file.size_bytes,
      sent_at: file.sent_at,
      fetch_url: `/files/${file.id}`,
      caption: file.caption,
      reply_to_msg_id: file.reply_to_msg_id,
      group_id: file.group_id,
    });
    ws.send(deliverFrame);
    markFileDelivered(db, file.id);
  }

  return pendingFiles.length;
}
