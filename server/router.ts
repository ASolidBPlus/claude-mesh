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
  subscribe as dbSubscribe,
  unsubscribe as dbUnsubscribe,
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
  const { msg_id, from, to, payload, kind } = frame;
  if (typeof msg_id !== 'string' || msg_id.length === 0) return refuse('bad_msg_id');
  if (typeof from !== 'string' || from.length === 0) return refuse('bad_from');
  if (typeof to !== 'string' || to.length === 0) return refuse('bad_to');
  if (typeof payload !== 'string') return refuse('bad_payload');
  if (kind !== 'direct') return refuse('bad_kind');

  // ONE HOP. `from`/`to` must be bare — a ':' would mean this peer is relaying
  // on behalf of a THIRD mesh, which is transitive federation nobody agreed to:
  // our admin's border decision covers this peer, not that peer's peers.
  if (Buffer.byteLength(from, 'utf8') > 256 || from.includes(':')) return refuse('from_not_one_hop');
  if (Buffer.byteLength(to, 'utf8') > 256 || to.includes(':')) return refuse('to_not_one_hop');

  const payloadBytes = Buffer.byteLength(payload, 'utf8');
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
  if (!Array.isArray(allowedKinds) || !allowedKinds.includes(kind)) return refuse('kind_not_permitted');

  // ── Dedupe on the REMOTE id, within RELAY_DEDUPE_MS. A repeat inside the
  // window is re-ACKed and delivered NOTHING: the peer's retry after a lost ack
  // must be safe. After the window the row is swept and the same id is a NEW
  // message BY DESIGN — a dedupe ledger that grew forever is the alternative.
  const seen = db.prepare('SELECT 1 FROM relays WHERE peer_alias = ? AND remote_msg_id = ?').get(alias, msg_id);
  if (seen !== null) {
    incPeerRelay(alias, 'in', 'duplicate');
    return { ok: true };
  }

  // ── Recipient and the inbound edge. Both answer the same RELAY_REFUSED.
  if (getAgentById(db, to) === null) return refuse('to_unknown');
  const stampedFrom = `${alias}:${from}`;
  if (!aclCheck(db, stampedFrom, to)) return refuse('no_edge');

  // ── Accept. A LOCAL id for messages.id: the remote id is the peer's
  // namespace and could collide with one of ours, so it lives only in `relays`.
  const localId = crypto.randomUUID();
  db.prepare('INSERT INTO relays (peer_alias, remote_msg_id, seen_at) VALUES (?, ?, ?)')
    .run(alias, msg_id, now);

  // (b) A peer's ttl is untrusted input. Negative is malformed; enormous
  // promises storage past the dedupe window, which is never honoured.
  const rawTtl = typeof frame.ttl_ms === 'number' ? frame.ttl_ms : 300_000;
  if (!Number.isFinite(rawTtl) || rawTtl < 0) return refuse('bad_ttl');
  const ttl = Math.min(rawTtl, MAX_TTL_MS);
  const content_type = typeof frame.content_type === 'string' ? frame.content_type : 'text/plain';
  deliverOrQueue(db, agentIndex, {
    id: localId,
    from_agent: stampedFrom,
    to_agent: to,
    payload,
    content_type,
    sent_at: now,
    expires_at: ttl === 0 ? null : now + ttl,
    ephemeral: ttl === 0,
    payloadBytes,
  });

  // CROSS-BORDER (inbound): `from` is a remote id stamped with the peer alias.
  emitTap(observerIndex, {
    type: 'tap', msg_id: localId, kind: 'direct',
    from: stampedFrom, to, topic: null, correlation_id: null,
    sent_at: now, size: payloadBytes, payload,
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

  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 2. Ensure topic exists
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

  // 5. Fan out to the local subscribers.
  fanOutTopicLocal(db, agentIndex, {
    topic: frame.topic,
    from_agent,
    origin: null,           // a locally-published post has no remote provenance
    aclPrincipal: from_agent,
    payload: frame.payload,
    content_type,
    sent_at,
    expires_at,
    ephemeral: ttl === 0,
    payloadBytes,
  });
  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'topic',
    from: from_agent, to: null, topic: frame.topic, correlation_id: null,
    sent_at, size: payloadBytes, payload: frame.payload,
  }, LOCAL_ONLY);

  return { ok: true, msg_id: frame.msg_id };
}

export function routeSubscribe(
  db: Database,
  agent_id: string,
  frame: SubscribeFrame
): RouterResult {
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
  dbUnsubscribe(db, agent_id, frame.topic);
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
