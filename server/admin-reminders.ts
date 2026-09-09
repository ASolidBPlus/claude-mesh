/**
 * #143 — Admin routes for reminders (`/reminders`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  bareIsoToUtc, cronNext, cronNextTz, cronValidate, isBareIso, tzValidate,
} from './cron.ts';
import {
  cancelReminder as dbCancelReminder, getAgentById, getReminder, insertReminder, listAgentReminders, listAllReminders, updateReminder,
} from './db.ts';
import {
  parseDuration,
} from './duration.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody } from './admin-ctx.ts';

export async function handleReminderPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const agent_id = body.agent_id;
  const payload = body.payload;

  if (typeof agent_id !== 'string' || !agent_id || getAgentById(db, agent_id) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }

  if (typeof payload !== 'string' || payload.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payload is required and must be a non-empty string' }));
    return;
  }
  if (Buffer.byteLength(payload, 'utf8') > 4096) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payload exceeds 4096 bytes' }));
    return;
  }

  const hasSchedule = body.schedule !== undefined;
  const hasDueAt = body.due_at !== undefined;
  const hasDuration = body.duration !== undefined;
  const timingCount = (hasSchedule ? 1 : 0) + (hasDueAt ? 1 : 0) + (hasDuration ? 1 : 0);

  if (timingCount !== 1) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'exactly one of schedule, due_at, or duration is required' }));
    return;
  }

  // Optional per-reminder IANA timezone (mirrors WS remind).
  const tzRaw = body.tz;
  if (tzRaw !== undefined && (typeof tzRaw !== 'string' || !tzValidate(tzRaw))) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid IANA timezone' }));
    return;
  }
  const tz = (typeof tzRaw === 'string') ? tzRaw : null;

  let due_at: number;
  let schedule: string | null;

  if (hasSchedule) {
    const sched = body.schedule;
    if (typeof sched !== 'string' || !cronValidate(sched)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid cron expression' }));
      return;
    }
    const next = tz !== null ? cronNextTz(sched, Date.now(), tz) : cronNext(sched, Date.now());
    if (next === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cron has no future occurrence within 366 days' }));
      return;
    }
    due_at = next;
    schedule = sched;
  } else if (hasDueAt) {
    const dueAtVal = body.due_at;
    if (tz !== null && typeof dueAtVal === 'string' && isBareIso(dueAtVal)) {
      // Bare offset-less ISO + tz → interpret as wall-clock in tz.
      due_at = bareIsoToUtc(dueAtVal, tz);
      schedule = null;
    } else if (typeof dueAtVal === 'number' && Number.isFinite(dueAtVal) && dueAtVal > Date.now()) {
      due_at = dueAtVal;
      schedule = null;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'due_at must be a future unix ms timestamp' }));
      return;
    }
  } else {
    const durVal = body.duration;
    const parsed = typeof durVal === 'string' ? parseDuration(durVal) : null;
    if (parsed === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'duration is unparseable or zero' }));
      return;
    }
    due_at = Date.now() + parsed;
    schedule = null;
  }

  const rem = insertReminder(db, {
    id: crypto.randomUUID(),
    agent_id,
    due_at,
    schedule,
    payload,
    created_at: Date.now(),
    tz,
  });

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rem));
}

export function handleReminderGet(ctx: AdminCtx): void {
  const { res, db, url } = ctx;
  const agent_id = url.searchParams.get('agent_id');
  if (agent_id) {
    // Optional filter: pending reminders for a single agent (back-compat).
    if (getAgentById(db, agent_id) === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found' }));
      return;
    }
    const reminders = listAgentReminders(db, agent_id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reminders));
    return;
  }
  // No agent_id: all pending reminders across the fleet (dashboard view).
  const reminders = listAllReminders(db);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reminders));
}

export async function handleReminderPatch(ctx: AdminCtx): Promise<void> {
  const { req, res, db, params } = ctx;
  const id = params.id;
  const existing = getReminder(db, id);
  if (existing === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'reminder not found' }));
    return;
  }

  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  // payload — optional, unchanged if absent
  let payload = existing.payload;
  if (body.payload !== undefined) {
    if (typeof body.payload !== 'string' || body.payload.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload must be a non-empty string' }));
      return;
    }
    if (Buffer.byteLength(body.payload, 'utf8') > 4096) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload exceeds 4096 bytes' }));
      return;
    }
    payload = body.payload;
  }

  // tz — optional. Present key resolves it (string→validate, null→clear to UTC); absent→unchanged.
  let tz = existing.tz;
  let tzChanged = false;
  if (Object.prototype.hasOwnProperty.call(body, 'tz')) {
    const tzRaw = body.tz;
    if (tzRaw === null) {
      tz = null;
      tzChanged = true;
    } else if (typeof tzRaw === 'string' && tzValidate(tzRaw)) {
      tz = tzRaw;
      tzChanged = true;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid IANA timezone' }));
      return;
    }
  }

  // when-field — at most one of schedule | due_at | duration
  const hasSchedule = body.schedule !== undefined;
  const hasDueAt = body.due_at !== undefined;
  const hasDuration = body.duration !== undefined;
  const timingCount = (hasSchedule ? 1 : 0) + (hasDueAt ? 1 : 0) + (hasDuration ? 1 : 0);
  if (timingCount > 1) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'at most one of schedule, due_at, or duration may be provided' }));
    return;
  }

  let schedule = existing.schedule;
  let due_at = existing.due_at;

  if (hasSchedule) {
    const sched = body.schedule;
    if (typeof sched !== 'string' || !cronValidate(sched)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'schedule must be a valid cron expression (to make a one-shot, set due_at or duration)' }));
      return;
    }
    const next = tz !== null ? cronNextTz(sched, Date.now(), tz) : cronNext(sched, Date.now());
    if (next === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cron has no future occurrence within 366 days' }));
      return;
    }
    schedule = sched;
    due_at = next;
  } else if (hasDueAt) {
    const dueAtVal = body.due_at;
    if (tz !== null && typeof dueAtVal === 'string' && isBareIso(dueAtVal)) {
      due_at = bareIsoToUtc(dueAtVal, tz);
      schedule = null;
    } else if (typeof dueAtVal === 'number' && Number.isFinite(dueAtVal) && dueAtVal > Date.now()) {
      due_at = dueAtVal;
      schedule = null;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'due_at must be a future unix ms timestamp' }));
      return;
    }
  } else if (hasDuration) {
    const durVal = body.duration;
    const parsed = typeof durVal === 'string' ? parseDuration(durVal) : null;
    if (parsed === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'duration is unparseable or zero' }));
      return;
    }
    due_at = Date.now() + parsed;
    schedule = null;
  } else if (tzChanged && existing.schedule !== null) {
    // No when-field, but tz changed on a recurring reminder → recompute next due in the new tz.
    const next = tz !== null ? cronNextTz(existing.schedule, Date.now(), tz) : cronNext(existing.schedule, Date.now());
    if (next === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cron has no future occurrence within 366 days' }));
      return;
    }
    due_at = next;
  }

  const updated = updateReminder(db, id, { payload, schedule, due_at, tz });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(updated));
}

export function handleReminderDelete(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id;
  const rem = getReminder(db, id);
  if (rem === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'reminder not found' }));
    return;
  }
  const cancelled = dbCancelReminder(db, id);
  if (!cancelled) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'reminder not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// Ordered route table — matched top-to-bottom, first match wins. Order mirrors
// the original inline if-chain exactly (exact paths before their `/:id`
// siblings). A path that matches no (method, matcher) pair falls through to the
// 404 at the end of dispatch — there is intentionally no 405.
/** Exported for tests ONLY: the dispatcher-guard test injects a throwing
    route to prove a handler exception cannot kill the process. */
