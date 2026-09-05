import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { unlinkSync } from 'fs';
import { countExpiredUndeliveredSince, sweepRetention, deleteExpiredFiles, deleteDeliveredOneShots, listDisabledAgentIds } from './db.ts';
import { incExpiredByKind } from './metrics.ts';

export interface CleanupHandle {
  stop(): void;
}

// ONE encoding of the cleanup-interval fact. It was previously parsed and
// range-validated in two places (here and server.ts) with the same bounds and
// the same error string — two copies of one rule drift silently, and the copy
// that drifts is the one nobody reads.
export function resolveCleanupIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return 60_000;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0 || parsed > 3_600_000) {
    process.stderr.write(`MESH_CLEANUP_INTERVAL_MS must be an integer between 1 and 3600000, got: ${raw}\n`);
    process.exit(1);
  }
  return parsed;
}

// §5.4 — revocation backstop. Deliberately NOT MESH_CLEANUP_INTERVAL_MS and
// deliberately not an env var: that knob exists to pace DB churn and is
// accepted up to an hour, so pacing revocation with it would let an operator
// tuning for churn silently widen the revocation-failure window to 60 minutes
// with nothing announcing the trade. This constant bounds how long a revoked
// agent can hold an already-authenticated socket, and it is the operator's
// business only in that it is always 15s.
export const DISABLED_SWEEP_INTERVAL_MS = 15_000;

export function startCleanup(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  intervalMs?: number,
  retentionMs?: number | null,
  // TEST SEAM ONLY, and deliberately a function parameter rather than an env
  // var: the operator surface stays fixed at DISABLED_SWEEP_INTERVAL_MS (see
  // its comment for why revocation latency must not be tunable). server.ts
  // never passes this; it exists so the sweep's WIRING can be tested in
  // milliseconds instead of being taken on faith for 15 seconds.
  disabledSweepIntervalMs?: number
): CleanupHandle {
  const resolvedIntervalMs = intervalMs ?? resolveCleanupIntervalMs(process.env.MESH_CLEANUP_INTERVAL_MS);

  const resolvedRetentionMs = retentionMs ?? null;

  // High-water mark for the windowed expired-undelivered counter: each tick
  // counts rows whose TTL fell in [lastExpireSweepAt, now) exactly once.
  let lastExpireSweepAt = Date.now();

  const timer = setInterval(() => {
    try {
      const now = Date.now();
      const expiredByKind = countExpiredUndeliveredSince(db, lastExpireSweepAt, now);
      lastExpireSweepAt = now;
      let expiredTotal = 0;
      for (const [kind, n] of Object.entries(expiredByKind)) {
        incExpiredByKind(kind, n);
        expiredTotal += n;
      }
      process.stdout.write(`[cleanup] expired ${expiredTotal} undelivered message(s)\n`);

      // Retention sweep: only when configured. Deletes rows older than the
      // window EXCEPT still-deliverable pending mail (see sweepRetention).
      if (resolvedRetentionMs !== null) {
        const removed = sweepRetention(db, resolvedRetentionMs);
        process.stdout.write(`[cleanup] retention swept ${removed} message(s)\n`);
      }

      const expiredPaths = deleteExpiredFiles(db);
      for (const p of expiredPaths) {
        try { unlinkSync(p); } catch {}
      }
      process.stdout.write(`[cleanup] expired ${expiredPaths.length} file(s)\n`);

      const deletedReminders = deleteDeliveredOneShots(db, Date.now() - 86_400_000);
      process.stdout.write(`[cleanup] cleaned ${deletedReminders} old delivered reminder(s)\n`);
    } catch (err) {
      process.stderr.write(`[cleanup] error during cleanup tick: ${err}\n`);
    }
  }, resolvedIntervalMs);

  // §5.4 revocation backstop. DELETE /registration-keys/:id commits the
  // revocation and then closes each agent's socket best-effort, outside the
  // transaction — so a crash between commit and close, or a socket not
  // reachable from that ctx, would leave a revoked agent holding a live
  // authenticated connection indefinitely. `disabled` is enforced at the auth
  // frame, which an ESTABLISHED socket has already passed.
  //
  // This makes the invariant STATE rather than an action: whatever happened at
  // revocation time, a disabled agent's socket is closed within
  // DISABLED_SWEEP_INTERVAL_MS. The immediate close stays as the fast path.
  //
  // Not a per-frame check: a lookup on every message is the wrong trade for
  // this bus today. If the 15s bound ever matters, per-frame is a follow-up
  // with its own test.
  const disabledTimer = setInterval(() => {
    try {
      for (const agentId of listDisabledAgentIds(db)) {
        const ws = agentIndex.get(agentId);
        if (ws === undefined) continue;
        // Logged because this firing means the immediate close at revocation
        // did NOT happen — the failure path is invisible otherwise, and a
        // backstop nobody can see firing is a backstop nobody knows is load-
        // bearing.
        console.log(JSON.stringify({ evt: 'agent.disabled_socket_swept', agent: agentId, at: Date.now() }));
        try {
          ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'identity revoked' }));
        } catch { /* ignore */ }
        try {
          ws.close(1008, 'identity revoked');
        } catch { /* ignore */ }
      }
    } catch (err) {
      process.stderr.write(`[cleanup] error during disabled-socket sweep: ${err}\n`);
    }
  }, disabledSweepIntervalMs ?? DISABLED_SWEEP_INTERVAL_MS);

  return {
    stop() {
      clearInterval(timer);
      clearInterval(disabledTimer);
    },
  };
}
