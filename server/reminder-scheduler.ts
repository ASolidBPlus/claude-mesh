import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import {
  getDueReminders,
  insertMessage,
  markDelivered,
  markReminderDelivered,
  updateReminderDueAt,
} from './db.ts';
import { buildDeliverFrame } from './router.ts';
import { cronNext, cronNextTz } from './cron.ts';

export interface ReminderSchedulerHandle {
  stop(): void;
  tick(): void; // run one scheduler cycle synchronously (for testing)
}

export function startReminderScheduler(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  intervalMs?: number
): ReminderSchedulerHandle {
  const interval = intervalMs ?? 10_000;

  const tick = () => {
    const now = Date.now();
    const due = getDueReminders(db, now);

    for (const reminder of due) {
      const msgId = crypto.randomUUID();

      // Insert the reminder as a normal mesh message. from_agent='mesh' is a
      // trusted system sender — the messages table has no FK on from_agent, so
      // no ACL check is needed.
      const m = insertMessage(db, {
        id: msgId,
        kind: 'reminder',
        from_agent: 'mesh',
        to_agent: reminder.agent_id,
        payload: reminder.payload,
        content_type: 'text/plain',
        sent_at: Date.now(),
        expires_at: null, // reminders never expire from the message queue
      });

      // Deliver immediately if the agent is online; otherwise leave the message
      // queued (delivered_at=NULL) for drainQueue to pick up on reconnect.
      const ws = agentIndex.get(reminder.agent_id);
      if (ws !== undefined && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(buildDeliverFrame(m));
        } catch (_) { /* ignore */ }
        markDelivered(db, m.id);
      }

      if (reminder.schedule === null) {
        // One-shot: mark delivered (produced a message row).
        markReminderDelivered(db, reminder.id, Date.now());
      } else {
        // Recurring: advance due_at to the next occurrence strictly after the
        // current wall-clock `now`, NOT after the stale stored due_at. This is
        // the deliberate COALESCE guarantee: if an agent missed several
        // recurring periods while offline, each tick inserts at most one
        // message and jumps past `now`, so all missed periods collapse into a
        // single delivery rather than a backlog storm on reconnect.
        const nextDue = reminder.tz
          ? cronNextTz(reminder.schedule, Date.now(), reminder.tz)
          : cronNext(reminder.schedule, Date.now());
        if (nextDue !== null) {
          updateReminderDueAt(db, reminder.id, nextDue, Date.now());
        } else {
          // No future occurrence within 366 days — retire the reminder.
          markReminderDelivered(db, reminder.id, Date.now());
        }
      }
    }

    if (due.length > 0) {
      process.stdout.write(`[reminders] fired ${due.length} reminder(s)\n`);
    }
  };

  const timer = setInterval(tick, interval);

  return {
    stop() { clearInterval(timer); },
    tick,
  };
}
