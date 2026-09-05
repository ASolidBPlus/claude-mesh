import { MeshClient } from './client.ts';
import type { ErrorFrame } from './protocol.ts';

/**
 * F0c (§7) — the client half of a mesh-to-mesh peer link.
 *
 * A PeerClient connects to a REMOTE mesh as a peer, not as an agent. It is a
 * thin specialisation of MeshClient over three seams (authExtras, isFatalError,
 * and the protected send machinery) rather than a parallel implementation,
 * because reconnection, backoff, liveness and ack bookkeeping are hard-won and
 * a second copy of them would drift.
 *
 * Peering is PAIRWISE and each side's admin controls its own border, so the two
 * directions are independent: this class speaks for the outbound half only.
 */

/** The relay frame a peer sends. `msg_id` is the REMOTE mesh's id for the
 *  message, which is what the receiving side dedupes on. */
export interface RelayFrame {
  type: 'relay';
  msg_id: string;
  kind: string;
  from: string;
  to: string;
  payload: string;
  content_type?: string;
  ttl_ms?: number;
}

export class PeerClient extends MeshClient {
  /**
   * Announce the protocol version on the auth frame. This is the ONLY thing
   * that distinguishes a peer connection from an agent connection at the wire
   * level, which is why an ordinary MeshClient's auth frame must stay
   * byte-identical to today's — a version that appeared on every frame would
   * make "is this a peer" unanswerable.
   */
  protected override authExtras(): Record<string, unknown> {
    return { protocol: 1 };
  }

  /**
   * A peer stops on AUTH_FAILED at ANY time, unlike an agent.
   *
   * For an agent, a post-first-auth AUTH_FAILED is usually a restarted server
   * and reconnecting is right. For a peer it means the far side REVOKED this
   * link — its admin made a decision — and reconnecting would be retrying
   * against a door somebody deliberately closed. PROTOCOL_MISMATCH is fatal for
   * both: no amount of retrying changes a version disagreement.
   */
  protected override isFatalError(frame: ErrorFrame): boolean {
    return frame.code === 'AUTH_FAILED' || frame.code === 'PROTOCOL_MISMATCH';
  }

  /**
   * Relay one message to the peer mesh, resolving when it acks.
   *
   * Keyed on the REMOTE msg_id so the ack correlates to the same id the
   * receiving side dedupes on — using a fresh local id would make a redelivered
   * relay indistinguishable from a new one.
   *
   * Rejects with whichever code applies: the peer's refusal (RELAY_REFUSED when
   * the kind is outside the border its admin set, RATE_LIMITED when over the
   * agreed rate) or the SDK's own (ACK_TIMEOUT, CONNECTION_RESET). The caller
   * gets one failure channel rather than having to inspect two.
   */
  relay(frame: RelayFrame): Promise<void> {
    return this.sendWithAck(frame.msg_id, frame);
  }
}
