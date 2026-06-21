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
  kind: string;                       // direct | topic | request | response | file
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

// Fire-and-forget fan-out to all connected observers. NEVER throws.
// - Iterates ONLY observerIndex (granted + connected observers) — the sole gate.
// - Per-observer try/catch so one broken socket can't break the loop or delivery.
// - Backpressure: skip any observer whose bufferedAmount exceeds the limit.
// - No persistence, no offline queue: an offline observer simply misses the frame.
export function emitTap(observerIndex: Map<string, WebSocket>, frame: TapFrame): void {
  try {
    const serialized = JSON.stringify(frame);
    for (const ws of observerIndex.values()) {
      try {
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
