import { EventEmitter } from 'events';

/**
 * The border forwarder's module — F2a ships ONLY the event bus.
 *
 * WHY A NEAR-EMPTY FILE IS THE RIGHT DELIVERABLE HERE: `router.ts` needs to
 * announce "a row was enqueued for this alias" the moment F2a's remote branch
 * exists, and F2b's forwarder needs to hear it. If the emitter arrived with the
 * forwarder, F2a's import would not resolve and the remote branch could not
 * ship independently. So the SEAM lands first and the machine lands second —
 * and every symbol crossing that boundary says which phase created it.
 *
 * F2b adds: the `Forwarder` class, the drain query, the token bucket and
 * in-flight cap, outcome handling, and the `create(row)` factory that
 * `POST /outbound-peers` refuses to work without.
 */

/**
 * Enqueue notifications, one per outbound alias.
 *
 * FIRE-AND-FORGET BY CONTRACT. `routeDirect` emits AFTER its synchronous
 * section — after the duplicate check, the insert and the ack — and never
 * awaits. An await between the duplicate check and the insert lets two frames
 * interleave, both pass the check, and the second insert throw; that invariant
 * is why this is an EventEmitter and not a promise-returning call.
 *
 * A listener that throws must not reach the router: EventEmitter delivers
 * synchronously, so F2b's handler owns its own try/catch. Stated here because
 * the coupling is invisible from the emit site.
 */
export const borderEvents = new EventEmitter();

/** Payload of the only event F2a emits: the alias whose queue just grew. */
export type EnqueuedEvent = string;

// ──────────────────────────────────────────────
// The forwarder (F2b)
// ──────────────────────────────────────────────

import { PeerClient } from '../client/src/peer-client.ts';
import {
  drainOutbound, expireStaleOutbound, markMessageFailed, markDelivered,
  listEnabledOutboundPeers, endOutboundPeering,
  type OutboundPeer, type Message,
} from './db.ts';
import { RELAY_DEDUPE_MS } from './cleanup.ts';
import { incPeerRelay } from './metrics.ts';
import type { Database } from 'bun:sqlite';
import type { WebSocket } from 'ws';

/** Backstop tick — the drain also runs on connect and on borderEvents, so this
 *  only catches a missed signal. Not the primary trigger. */
const BACKSTOP_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * One outbound peering's forwarder.
 *
 * PACING IS SENDER-SIDE AND DELIBERATE. The receiver has its own bucket and
 * answers RATE_LIMITED, but arriving at its limit and being refused is worse
 * than not arriving: the refusal costs a round trip, counts against the
 * receiver's bucket (refused relays count, by design), and leaves the row to
 * retry. So we pace to the rate the peering was configured with and treat a
 * RATE_LIMITED as evidence our estimate is too high.
 */
export class Forwarder {
  private client: PeerClient | null = null;
  private inFlight = new Set<string>();
  private tokens: number;
  private lastRefill = Date.now();
  private refillPerMin: number;
  private backoff = BACKOFF_MIN_MS;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly cap: number;

  constructor(
    private readonly db: Database,
    private row: OutboundPeer,
    private readonly agentIndex: Map<string, WebSocket>,
  ) {
    this.refillPerMin = row.rate_per_min;
    this.tokens = row.rate_per_min;              // burst == sustained
    this.cap = Math.max(1, Math.min(50, Math.floor(row.rate_per_min / 4)));
  }

  get alias(): string { return this.row.alias; }
  /** For #108's gauge: 0 or 1, never absent. */
  get connected(): boolean { return this.client !== null; }

  start(): void {
    if (this.stopped) return;
    // C7: the ONLY production read of outbound_peers.token. It goes to the
    // SDK's auth frame and nowhere else — not to a log, not to a metric label.
    this.client = new PeerClient({
      serverUrl: this.row.url,
      agentId: this.row.assigned_alias,
      agentToken: this.row.token,
    });
    this.client.on('error', (e: unknown) => this.onFatal(e as { code?: string }));
    this.client.connect().then(() => this.drain()).catch(() => this.scheduleRetry());
    this.tick = setInterval(() => this.drain(), BACKSTOP_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.tick !== null) { clearInterval(this.tick); this.tick = null; }
    if (this.backoffTimer !== null) { clearTimeout(this.backoffTimer); this.backoffTimer = null; }
    try { this.client?.close(); } catch { /* ignore */ }
    this.client = null;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.backoffTimer !== null) return;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      this.drain();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  /** A FATAL error means the far side will not accept us unaided (§5.6). */
  private onFatal(err: { code?: string }): void {
    if (err?.code !== 'AUTH_FAILED') return;
    // Receiver-side revocation: the door where nobody typed a command, and the
    // less observable of the two. A revoked peering is NOT a down peering — it
    // will not recover — so its queued rows are undeliverable from this instant
    // and would otherwise sit pending forever.
    // (e) TRUST BOUNDARY OF THIS DECISION, stated because it is a
    // disable-on-a-frame:
    //   - over wss:// with verified certificates (the only non-loopback form
    //     POST/PATCH accept), the frame is genuinely the remote's;
    //   - over loopback ws://, an on-path injector could send AUTH_FAILED and
    //     disable the peering.
    // The bound is ACCEPTED: an attacker already on loopback has better
    // options, and the failure is RECOVERABLE by PATCH {enabled:true} — a
    // denial of service, not a compromise. The frame is logged verbatim so an
    // operator can see what disabled it rather than inferring.
    console.error(JSON.stringify({
      evt: 'outbound_peering.revoked_by_receiver', alias: this.row.alias,
      frame: err, at: Date.now(),
    }));
    endOutboundPeering(this.db, this.row.alias, 'revoked_by_receiver');
    this.stop();
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.refillPerMin, this.tokens + (this.refillPerMin * elapsed) / 60_000);
  }

  /** Drain what the bucket and the in-flight cap both allow. */
  drain(): void {
    if (this.stopped || this.client === null) return;
    const now = Date.now();

    // Past the receiver's dedupe window: it has forgotten these ids, so a
    // re-send would be delivered a second time. Expire rather than send.
    expireStaleOutbound(this.db, this.row.alias, now, RELAY_DEDUPE_MS);

    this.refill(now);
    const budget = Math.min(Math.floor(this.tokens), this.cap - this.inFlight.size);
    if (budget <= 0) return;

    const rows = drainOutbound(this.db, this.row.alias, now, RELAY_DEDUPE_MS, budget)
      .filter(r => !this.inFlight.has(r.id));
    for (const row of rows) this.send(row, now);
  }

  private send(row: Message, now: number): void {
    if (this.client === null) return;
    this.tokens -= 1;
    this.inFlight.add(row.id);

    const remote = row.to_agent!.slice(row.to_agent!.indexOf(':') + 1);
    // Never 0 for a stored row: ttl 0 means ephemeral, and this row is queued.
    const ttl = row.expires_at === null ? undefined : Math.max(1, row.expires_at - now);

    this.client.relay({
      type: 'relay',
      msg_id: row.id,
      kind: 'direct',
      from: row.from_agent,
      to: remote,
      payload: row.payload,
      content_type: row.content_type,
      ...(ttl !== undefined ? { ttl_ms: ttl } : {}),
    }).then(
      () => {
        this.inFlight.delete(row.id);
        // delivered_at is set ONLY on the peer's ack — never on send.
        markDelivered(this.db, row.id);
        incPeerRelay(this.row.alias, 'outbound', 'delivered');
        // (a) THE BACKOFF RESETS HERE AND NOWHERE ELSE — on a relay ACK, never
        // on connect. A far side that accepts the TCP/WS connection and then
        // drops or refuses everything would otherwise reset the backoff on
        // every reconnect, defeating it entirely: the forwarder would hammer a
        // peering that is up in the only sense that costs us nothing to check.
        // Progress means a message was accepted, not that a socket opened.
        this.backoff = BACKOFF_MIN_MS;
        this.drain();
      },
      (err: { code?: string }) => {
        this.inFlight.delete(row.id);
        this.onSendError(row, err);
      },
    );
  }

  private onSendError(row: Message, err: { code?: string }): void {
    const code = err?.code ?? 'UNKNOWN';

    if (code === 'RELAY_REFUSED') {
      // PERMANENT. The far side will refuse this message every time — no
      // amount of retrying changes a border decision.
      markMessageFailed(this.db, row.id, code, Date.now());
      incPeerRelay(this.row.alias, 'outbound', 'refused');
      // Tell the originating agent if it is still here (D5). Best-effort: a
      // sender that has gone offline learns nothing, which is why failed_code
      // is on the row rather than only in a frame.
      const sock = this.agentIndex.get(row.from_agent);
      if (sock !== undefined) {
        try {
          sock.send(JSON.stringify({ type: 'error', code: 'REMOTE_REFUSED', ref: row.id }));
        } catch { /* ignore */ }
      }
      return;
    }

    if (code === 'RATE_LIMITED') {
      // Our estimate of the receiver's capacity is too high. Halve the local
      // refill until the next success rather than retrying at the same rate —
      // otherwise an over-stated rate_per_min loops instead of converging.
      this.refillPerMin = Math.max(1, Math.floor(this.refillPerMin / 2));
      incPeerRelay(this.row.alias, 'outbound', 'rate_limited');
      this.scheduleRetry();
      return;
    }

    // ACK_TIMEOUT / CONNECTION_RESET / anything else: TRANSIENT. The row stays
    // pending and leaves in-flight, so the next drain picks it up.
    incPeerRelay(this.row.alias, 'outbound', 'transient');
    this.scheduleRetry();
  }
}

/** alias -> forwarder, for the admin handlers and the gauge. */
export const forwarders = new Map<string, Forwarder>();

/**
 * Wire the border into a running server: register the factory the admin API
 * refuses to work without, start a forwarder per ENABLED row, and drain on
 * enqueue.
 *
 * BOOT IS F2b's. F2a starts nothing and passes no registry — that is what keeps
 * the front half inert between the two merges, and it means the boot path had
 * no owner until now.
 */
export function startBorder(db: Database, agentIndex: Map<string, WebSocket>): {
  create: (row: OutboundPeer) => void;
  stop: (alias: string) => void;
  stopAll: () => void;
} {
  const create = (row: OutboundPeer): void => {
    forwarders.get(row.alias)?.stop();
    const f = new Forwarder(db, row, agentIndex);
    forwarders.set(row.alias, f);
    f.start();
  };
  const stop = (alias: string): void => {
    forwarders.get(alias)?.stop();
    forwarders.delete(alias);
  };

  for (const row of listEnabledOutboundPeers(db)) create(row);

  borderEvents.on('enqueued', (alias: EnqueuedEvent) => {
    // The listener owns its try/catch: EventEmitter delivers synchronously, so
    // a throw here would reach routeDirect's emit site.
    try { forwarders.get(alias)?.drain(); } catch (err) {
      console.error(JSON.stringify({ evt: 'border.drain_threw', alias, error: String(err), at: Date.now() }));
    }
  });

  return { create, stop, stopAll: () => { for (const f of forwarders.values()) f.stop(); forwarders.clear(); } };
}
