import { WebSocket } from 'ws';

// Backpressure guard: if an observer socket has more than this many bytes already
// buffered (slow/stuck consumer), SKIP the tap frame for that observer rather than
// pile more onto the bus. Protects delivery latency for everyone else.
export const TAP_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024; // 8 MB

// A tap frame is a fully-built object ready to JSON.stringify. Built once per
// accepted message by the caller (the router chokepoint), then fanned out here.
export interface TapFrame {
  type: 'tap';
  msg_id: string;
  kind: string;                       // direct | topic | file
  from: string;
  to: string | null;
  topic: string | null;
  correlation_id: string | null;
  sent_at: number;
  size: number;                       // payload byte length (file: file size_bytes)
  payload?: string | null;            // present for non-file kinds; null/omitted for file
  // file-only metadata (present only when kind === 'file'):
  file_id?: string;
  filename?: string;
  content_type?: string;
}

/**
 * Who a tap frame may be shown to.
 *
 * REQUIRED at every call site, and a discriminated union rather than an
 * optional flag, on purpose: an optional `crossBorder?: boolean` would let a
 * NEW cross-border path reach observers simply by not mentioning the question,
 * which is the exact failure the cross_border grant exists to stop — a
 * category-phrased grant ("observers see everything") whose scope is widened by
 * a feature nobody thought to re-scope. Making it required converts that from a
 * silent default into a compile error.
 *
 * Note the type does not let you claim `crossBorder: true` without supplying
 * the scoped set, so "cross-border, audience unknown" is unrepresentable.
 */
export type TapAudience =
  | { crossBorder: false }
  | { crossBorder: true; scoped: ReadonlySet<string> };

// Fire-and-forget fan-out to observers. NEVER throws.
// - Iterates observerIndex (granted + connected observers).
// - For a cross-border frame, an observer must ALSO be in `scoped` (F3).
// - Per-observer try/catch so one broken socket can't break the loop or delivery.
// - Backpressure: skip any observer whose bufferedAmount exceeds the limit.
// - No persistence, no offline queue: an offline observer simply misses the frame.
export function emitTap(
  observerIndex: Map<string, WebSocket>,
  frame: TapFrame,
  audience: TapAudience,
): void {
  try {
    const serialized = JSON.stringify(frame);
    for (const [agentId, ws] of observerIndex.entries()) {
      try {
        // F3 GATE. Ordered before the backpressure check and before send() so
        // that no branch below can reach an out-of-scope observer.
        if (audience.crossBorder && !audience.scoped.has(agentId)) continue;
        // Backpressure guard — protect the bus from slow observers.
        if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > TAP_BUFFER_LIMIT_BYTES) {
          continue;
        }
        ws.send(serialized);
      } catch (_) {
        // One bad observer socket must not affect delivery or other observers.
      }
    }
  } catch (_) {
    // A malformed frame (e.g. circular) must never throw into the route fn.
  }
}

/** The audience for any frame that stays inside this mesh. */
export const LOCAL_ONLY: TapAudience = { crossBorder: false };
