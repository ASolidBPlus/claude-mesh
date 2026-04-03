import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { expireMessages, deleteExpiredFiles } from './db.ts';
import { PendingRequest } from './router.ts';

export interface CleanupHandle {
  stop(): void;
}

export function startCleanup(
  db: Database,
  pendingRequests: Map<string, PendingRequest>,
  agentIndex: Map<string, WebSocket>,
  intervalMs?: number
): CleanupHandle {
  const resolvedIntervalMs = intervalMs ?? parseInt(process.env.MESH_CLEANUP_INTERVAL_MS ?? '60000', 10);

  if (isNaN(resolvedIntervalMs) || resolvedIntervalMs <= 0 || resolvedIntervalMs > 3_600_000) {
    process.stderr.write(`MESH_CLEANUP_INTERVAL_MS must be an integer between 1 and 3600000, got: ${process.env.MESH_CLEANUP_INTERVAL_MS}\n`);
    process.exit(1);
  }

  const timer = setInterval(() => {
    try {
      const expired = expireMessages(db);
      process.stdout.write(`[cleanup] expired ${expired} message(s)\n`);

      const expiredFiles = deleteExpiredFiles(db);
      process.stdout.write(`[cleanup] expired ${expiredFiles} file(s)\n`);

      let expiredRequests = 0;
      for (const [correlationId, entry] of pendingRequests) {
        if (entry.expiresAt <= Date.now()) {
          clearTimeout(entry.timer);

          if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({
              type: 'error',
              ref: correlationId,
              code: 'REQUEST_TIMEOUT',
              message: 'request expired during server cleanup',
            }));
          }

          if (entry.reject) {
            entry.reject(new Error('REQUEST_TIMEOUT'));
          }

          pendingRequests.delete(correlationId);
          expiredRequests++;
        }
      }

      process.stdout.write(`[cleanup] expired ${expiredRequests} pending request(s)\n`);
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
