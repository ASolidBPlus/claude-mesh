import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { unlinkSync } from 'fs';
import { countExpiredUndeliveredSince, sweepRetention, sweepFileRetention, deleteExpiredFiles, deleteDeliveredOneShots, sweepRelays } from './db.ts';
import { incExpiredByKind } from './metrics.ts';

export interface CleanupHandle {
  stop(): void;
}

/** How long a relayed remote msg_id is remembered for dedupe (F0b, §4). Seven
    days: long enough that a peer reconnecting after an outage cannot replay,
    short enough that the ledger stays bounded. A constant, not a knob —
    shortening it silently widens a replay window, and a security bound must
    never sit on a tunable. */
export const RELAY_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;

export function startCleanup(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  intervalMs?: number,
  retentionMs?: number | null
): CleanupHandle {
  const resolvedIntervalMs = intervalMs ?? parseInt(process.env.MESH_CLEANUP_INTERVAL_MS ?? '60000', 10);

  if (isNaN(resolvedIntervalMs) || resolvedIntervalMs <= 0 || resolvedIntervalMs > 3_600_000) {
    process.stderr.write(`MESH_CLEANUP_INTERVAL_MS must be an integer between 1 and 3600000, got: ${process.env.MESH_CLEANUP_INTERVAL_MS}\n`);
    process.exit(1);
  }

  const resolvedRetentionMs = retentionMs ?? null;

  // High-water mark for the windowed expired-undelivered counter: each tick
  // counts rows whose TTL fell in [lastExpireSweepAt, now) exactly once.
  let lastExpireSweepAt = Date.now();

  // WHICH TIMER A STEP BELONGS ON (repo rule, from #85's review): the
  // all-or-nothing tick is acceptable for HOUSEKEEPING, where a skipped step is
  // a delay that retries next tick. A step whose skipping would be a SECURITY
  // EVENT needs its own timer. Every step below is the first kind, the relay
  // sweep included — its rows only refuse a redelivered relay inside the dedupe
  // window, so a skipped sweep costs disk, never correctness.
  //
  // The main tick is ALL-OR-NOTHING per iteration: every step shares one try,
  // so a throw in step N skips N+1 onward and they retry together next tick.
  // That is tolerable because each step is idempotent and re-derives its own
  // window, but it means ORDER CARRIES A DEPENDENCY — anything added here
  // inherits "may be skipped whenever an earlier step throws". A step that
  // must run regardless needs its own try, not a new line at the bottom.
  // (Pre-existing behaviour; stated because #39 added a step and the next
  // person will add another.)
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

      // UNDELIVERED + expired only (#39): a delivered file's bytes are history
      // now, removed by the retention sweep below rather than by delivery TTL.
      const expiredPaths = deleteExpiredFiles(db);
      // Unlink AFTER the row delete, never before: a crash between the two
      // would otherwise leave rows pointing at missing bytes, which reads as
      // corruption rather than cleanup. An unlink failure is logged, never
      // fatal — a leaked byte-blob is recoverable, a dead cleanup loop is not.
      for (const p of expiredPaths) {
        try { unlinkSync(p); } catch (err) {
          console.warn(`[cleanup] file bytes not unlinked (row already removed): ${p}: ${(err as Error).message}`);
        }
      }
      process.stdout.write(`[cleanup] expired ${expiredPaths.length} file(s)\n`);

      // Files retention sweep (#39): the twin of the messages sweep above, and
      // the ONLY path that removes a delivered file. Same still-deliverable
      // exclusion, same delete-then-unlink order.
      if (resolvedRetentionMs !== null) {
        const sweptPaths = sweepFileRetention(db, resolvedRetentionMs);
        for (const p of sweptPaths) {
          try { unlinkSync(p); } catch (err) {
            console.warn(`[cleanup] file bytes not unlinked (row already removed): ${p}: ${(err as Error).message}`);
          }
        }
        process.stdout.write(`[cleanup] retention swept ${sweptPaths.length} file(s)\n`);
      }

      // Relay dedupe ledger (F0b). Housekeeping — see the rule above.
      const sweptRelays = sweepRelays(db, RELAY_DEDUPE_MS);
      if (sweptRelays > 0) process.stdout.write(`[cleanup] swept ${sweptRelays} relay ledger row(s)\n`);

      const deletedReminders = deleteDeliveredOneShots(db, Date.now() - 86_400_000);
      process.stdout.write(`[cleanup] cleaned ${deletedReminders} old delivered reminder(s)\n`);
    } catch (err) {
      process.stderr.write(`[cleanup] error during cleanup tick: ${err}\n`);
    }
  }, resolvedIntervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
