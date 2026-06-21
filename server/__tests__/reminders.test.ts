import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  openDb,
  registerAgent,
  deleteAgent,
  insertReminder,
  getReminder,
  getDueReminders,
  listAgentReminders,
  cancelReminder,
  markReminderDelivered,
  updateReminderDueAt,
  deleteDeliveredOneShots,
} from '../db.ts';
import { startReminderScheduler } from '../reminder-scheduler.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { generateToken, hashToken } from '../auth.ts';
import { cronNext, cronNextTz, wallTimeToUtc } from '../cron.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ──────────────────────────────────────────────
// DB helper tests (no server)
// ──────────────────────────────────────────────

describe('reminder DB helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'agentA', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'agentB', token_hash: 'b'.repeat(64), hostname: 'h2' });
  });

  afterEach(() => { db.close(); });

  it('insertReminder + getReminder round-trip', () => {
    const now = Date.now();
    const rem = insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, schedule: null, payload: 'hi', created_at: now });
    expect(rem.id).toBe('r1');
    expect(rem.agent_id).toBe('agentA');
    expect(rem.due_at).toBe(now + 1000);
    expect(rem.schedule).toBe(null);
    expect(rem.payload).toBe('hi');
    expect(rem.created_at).toBe(now);
    expect(rem.status).toBe('pending');
    expect(rem.last_fired_at).toBe(null);
    const got = getReminder(db, 'r1');
    expect(got).toEqual(rem);
  });

  it('getDueReminders returns pending reminders with due_at <= now', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, payload: 'p', created_at: now });
    insertReminder(db, { id: 'r2', agent_id: 'agentA', due_at: now - 500, payload: 'p', created_at: now });
    const due = getDueReminders(db, now);
    expect(due.map(r => r.id)).toEqual(['r1', 'r2']);
  });

  it('getDueReminders excludes cancelled/delivered reminders', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, payload: 'p', created_at: now });
    insertReminder(db, { id: 'r2', agent_id: 'agentA', due_at: now - 1000, payload: 'p', created_at: now });
    cancelReminder(db, 'r1');
    markReminderDelivered(db, 'r2', now);
    const due = getDueReminders(db, now);
    expect(due.length).toBe(0);
  });

  it('getDueReminders excludes future reminders', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 100000, payload: 'p', created_at: now });
    const due = getDueReminders(db, now);
    expect(due.length).toBe(0);
  });

  it('listAgentReminders returns only specified agent pending reminders', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now });
    insertReminder(db, { id: 'r2', agent_id: 'agentB', due_at: now + 1000, payload: 'p', created_at: now });
    const list = listAgentReminders(db, 'agentA');
    expect(list.map(r => r.id)).toEqual(['r1']);
  });

  it('cancelReminder sets status to cancelled, returns true', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now });
    expect(cancelReminder(db, 'r1')).toBe(true);
    expect(getReminder(db, 'r1')!.status).toBe('cancelled');
  });

  it('cancelReminder on non-pending returns false', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now });
    cancelReminder(db, 'r1');
    expect(cancelReminder(db, 'r1')).toBe(false);
  });

  it('markReminderDelivered sets status and last_fired_at', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now, payload: 'p', created_at: now });
    markReminderDelivered(db, 'r1', now + 5);
    const r = getReminder(db, 'r1')!;
    expect(r.status).toBe('delivered');
    expect(r.last_fired_at).toBe(now + 5);
  });

  it('updateReminderDueAt updates due_at and last_fired_at, keeps pending', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now, schedule: '* * * * *', payload: 'p', created_at: now });
    updateReminderDueAt(db, 'r1', now + 60000, now + 1);
    const r = getReminder(db, 'r1')!;
    expect(r.due_at).toBe(now + 60000);
    expect(r.last_fired_at).toBe(now + 1);
    expect(r.status).toBe('pending');
  });

  it('deleteDeliveredOneShots removes old delivered one-shots', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now, schedule: null, payload: 'p', created_at: now });
    markReminderDelivered(db, 'r1', now - 100000);
    const deleted = deleteDeliveredOneShots(db, now - 1000);
    expect(deleted).toBe(1);
    expect(getReminder(db, 'r1')).toBe(null);
  });

  it('deleteDeliveredOneShots does not remove recurring or pending', () => {
    const now = Date.now();
    // pending one-shot
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, schedule: null, payload: 'p', created_at: now });
    // delivered recurring (schedule not null)
    insertReminder(db, { id: 'r2', agent_id: 'agentA', due_at: now, schedule: '* * * * *', payload: 'p', created_at: now });
    markReminderDelivered(db, 'r2', now - 100000);
    const deleted = deleteDeliveredOneShots(db, now - 1000);
    expect(deleted).toBe(0);
    expect(getReminder(db, 'r1')).not.toBe(null);
    expect(getReminder(db, 'r2')).not.toBe(null);
  });

  it('deleting an agent cascades to delete its reminders', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now });
    deleteAgent(db, 'agentA');
    expect(getReminder(db, 'r1')).toBe(null);
  });

  it('test 18: insertReminder + getReminder tz round-trip', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now, tz: 'Australia/Adelaide' });
    expect(getReminder(db, 'r1')!.tz).toBe('Australia/Adelaide');
    insertReminder(db, { id: 'r2', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now });
    expect(getReminder(db, 'r2')!.tz).toBe(null);
  });

  it('test 19: migration / default null tz preserves UTC semantics', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 1000, payload: 'p', created_at: now });
    expect(getReminder(db, 'r1')!.tz).toBe(null);
  });
});

// ──────────────────────────────────────────────
// Scheduler tests (no live WS server needed — use fake ws objects)
// ──────────────────────────────────────────────

function fakeWs(): { ws: any; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(data: string) { sent.push(data); },
  };
  return { ws, sent };
}

function countMessagesFor(db: Database, agentId: string): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE to_agent = ?').get(agentId) as { cnt: number };
  return row.cnt;
}

describe('reminder scheduler', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'agentA', token_hash: 'a'.repeat(64), hostname: 'h1' });
  });

  afterEach(() => { db.close(); });

  it('one-shot delivery to online agent: message inserted + delivered, WS receives frame, reminder marked delivered', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, schedule: null, payload: 'ping', created_at: now });
    const { ws, sent } = fakeWs();
    const index = new Map<string, any>([['agentA', ws]]);
    const sched = startReminderScheduler(db, index as any, 999999);
    sched.tick();
    sched.stop();

    expect(countMessagesFor(db, 'agentA')).toBe(1);
    const msgRow = db.prepare('SELECT * FROM messages WHERE to_agent = ?').get('agentA') as any;
    expect(msgRow.kind).toBe('reminder');
    expect(msgRow.from_agent).toBe('mesh');
    expect(msgRow.payload).toBe('ping');
    expect(msgRow.delivered_at).not.toBe(null);

    expect(sent.length).toBe(1);
    const frame = JSON.parse(sent[0]);
    expect(frame.type).toBe('deliver');
    expect(frame.kind).toBe('reminder');
    expect(frame.payload).toBe('ping');

    expect(getReminder(db, 'r1')!.status).toBe('delivered');
  });

  it('one-shot delivery to offline agent: message inserted but not delivered, reminder marked delivered', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, schedule: null, payload: 'ping', created_at: now });
    const index = new Map<string, any>(); // agent offline
    const sched = startReminderScheduler(db, index as any, 999999);
    sched.tick();
    sched.stop();

    expect(countMessagesFor(db, 'agentA')).toBe(1);
    const msgRow = db.prepare('SELECT * FROM messages WHERE to_agent = ?').get('agentA') as any;
    expect(msgRow.delivered_at).toBe(null);
    expect(getReminder(db, 'r1')!.status).toBe('delivered');
  });

  it('recurring delivery: message inserted, reminder stays pending with updated due_at', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, schedule: '* * * * *', payload: 'tick', created_at: now });
    const { ws } = fakeWs();
    const index = new Map<string, any>([['agentA', ws]]);
    const sched = startReminderScheduler(db, index as any, 999999);
    sched.tick();
    sched.stop();

    expect(countMessagesFor(db, 'agentA')).toBe(1);
    const r = getReminder(db, 'r1')!;
    expect(r.status).toBe('pending');
    expect(r.due_at).toBeGreaterThan(Date.now());
  });

  it('not-yet-due reminder: tick produces no messages', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now + 100000, payload: 'p', created_at: now });
    const sched = startReminderScheduler(db, new Map() as any, 999999);
    sched.tick();
    sched.stop();
    expect(countMessagesFor(db, 'agentA')).toBe(0);
  });

  it('cancelled reminder: tick does not fire it', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, payload: 'p', created_at: now });
    cancelReminder(db, 'r1');
    const sched = startReminderScheduler(db, new Map() as any, 999999);
    sched.tick();
    sched.stop();
    expect(countMessagesFor(db, 'agentA')).toBe(0);
  });

  it('stop() prevents further ticks', async () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 1000, payload: 'p', created_at: now });
    const sched = startReminderScheduler(db, new Map() as any, 20);
    sched.stop();
    await new Promise(r => setTimeout(r, 80));
    expect(countMessagesFor(db, 'agentA')).toBe(0);
  });

  it('recurring-while-offline COALESCE: one tick inserts exactly one message, reminder stays pending advanced past now', () => {
    const now = Date.now();
    // due_at several periods in the past
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 10 * 60_000, schedule: '* * * * *', payload: 'p', created_at: now });
    const index = new Map<string, any>(); // offline
    const sched = startReminderScheduler(db, index as any, 999999);
    sched.tick();
    sched.stop();

    expect(countMessagesFor(db, 'agentA')).toBe(1);
    const r = getReminder(db, 'r1')!;
    expect(r.status).toBe('pending');
    expect(r.due_at).toBeGreaterThan(Date.now());
  });

  it('test 20: scheduler recurring-advance uses stored tz', () => {
    const now = Date.now();
    insertReminder(db, { id: 'r1', agent_id: 'agentA', due_at: now - 60_000, schedule: '0 9 * * 1', payload: 'p', created_at: now, tz: 'Australia/Adelaide' });
    const index = new Map<string, any>(); // offline
    const sched = startReminderScheduler(db, index as any, 999999);
    sched.tick();
    sched.stop();

    expect(countMessagesFor(db, 'agentA')).toBe(1);
    const r = getReminder(db, 'r1')!;
    expect(r.status).toBe('pending');
    const expectedTz = cronNextTz('0 9 * * 1', Date.now(), 'Australia/Adelaide');
    const plainUtc = cronNext('0 9 * * 1', Date.now());
    expect(r.due_at).toBe(expectedTz);
    // Meaningful: the tz-aware advance differs from the plain UTC advance.
    expect(expectedTz).not.toBe(plainUtc);
  });
});

// ──────────────────────────────────────────────
// WS frame handler tests (live WS server)
// ──────────────────────────────────────────────

let portCounter = 19400;
function nextPort() { return portCounter++; }

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// Collect all incoming messages; provide a way to wait for a frame matching a predicate.
function makeCollector(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) {
        waiters[i].resolve(m);
        waiters.splice(i, 1);
        return;
      }
    }
    queue.push(m);
  });
  return {
    wait(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
      for (let i = 0; i < queue.length; i++) {
        if (pred(queue[i])) { return Promise.resolve(queue.splice(i, 1)[0]); }
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
  };
}

async function authConnect(port: number, db: Database, agentId: string) {
  const rawToken = generateToken();
  registerAgent(db, { id: agentId, token_hash: hashToken(rawToken), hostname: 'h' });
  const ws = await connectWs(port);
  const col = makeCollector(ws);
  ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token: rawToken }));
  await col.wait(m => m.type === 'auth_ok');
  return { ws, col };
}

describe('reminder WS frame handlers', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('remind with duration "2s": ack with reminder_id and due_at ~ now+2000', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const before = Date.now();
    ws.send(JSON.stringify({ type: 'remind', text: 'wake', when: '2s' }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.ok).toBe(true);
    expect(typeof ack.reminder_id).toBe('string');
    expect(ack.due_at).toBeGreaterThanOrEqual(before + 1900);
    expect(ack.due_at).toBeLessThanOrEqual(Date.now() + 2100);
    ws.close();
  });

  it('remind with ISO datetime: ack with correct due_at', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const future = Date.now() + 3_600_000;
    const iso = new Date(future).toISOString();
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: iso }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.due_at).toBe(future);
    ws.close();
  });

  it('remind with recurring cron: ack with schedule set', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '*/5 * * * *', recurring: true }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.ok).toBe(true);
    const rem = getReminder(db, ack.reminder_id)!;
    expect(rem.schedule).toBe('*/5 * * * *');
    ws.close();
  });

  it('remind with recurring "0 9 * * 1" (weekly): ack with schedule and next-Monday due_at', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const before = Date.now();
    ws.send(JSON.stringify({ type: 'remind', text: 'weekly', when: '0 9 * * 1', recurring: true }));
    const ack = await col.wait(m => m.type === 'ack');
    const rem = getReminder(db, ack.reminder_id)!;
    expect(rem.schedule).toBe('0 9 * * 1');
    const expected = cronNext('0 9 * * 1', before);
    // due_at computed at handler time; allow tolerance window around expected
    expect(Math.abs(ack.due_at - expected!)).toBeLessThanOrEqual(60_000);
    const d = new Date(ack.due_at);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(9);
    ws.close();
  });

  it('remind with invalid when: error INVALID_WHEN', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: 'not-a-time' }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('INVALID_WHEN');
    ws.close();
  });

  it('remind with past ISO: error INVALID_WHEN', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const past = new Date(Date.now() - 100000).toISOString();
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: past }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('INVALID_WHEN');
    ws.close();
  });

  it('remind with invalid cron + recurring: error INVALID_CRON', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '99 * * * *', recurring: true }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('INVALID_CRON');
    ws.close();
  });

  it('remind with oversized text: error PAYLOAD_TOO_LARGE', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x'.repeat(4097), when: '2s' }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
    ws.close();
  });

  it('list_reminders: returns agent pending reminders', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'one', when: '1h' }));
    await col.wait(m => m.type === 'ack');
    ws.send(JSON.stringify({ type: 'list_reminders' }));
    const list = await col.wait(m => m.type === 'reminders_list');
    expect(list.reminders.length).toBe(1);
    expect(list.reminders[0].payload).toBe('one');
    ws.close();
  });

  it('cancel_reminder: ack, then list_reminders returns fewer', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'one', when: '1h' }));
    const ack1 = await col.wait(m => m.type === 'ack');
    ws.send(JSON.stringify({ type: 'remind', text: 'two', when: '2h' }));
    await col.wait(m => m.type === 'ack');

    ws.send(JSON.stringify({ type: 'cancel_reminder', msg_id: 'cx-1', id: ack1.reminder_id }));
    const cancelAck = await col.wait(m => m.type === 'ack' && m.ref === 'cx-1');
    expect(cancelAck.ok).toBe(true);

    ws.send(JSON.stringify({ type: 'list_reminders' }));
    const list = await col.wait(m => m.type === 'reminders_list');
    expect(list.reminders.length).toBe(1);
    ws.close();
  });

  it('cancel_reminder with other agent ID: error REMINDER_NOT_FOUND', async () => {
    const other = await authConnect(port, db, 'a2');
    other.ws.send(JSON.stringify({ type: 'remind', text: 'theirs', when: '1h' }));
    const otherAck = await other.col.wait(m => m.type === 'ack');
    other.ws.close();

    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'cancel_reminder', id: otherAck.reminder_id }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('REMINDER_NOT_FOUND');
    ws.close();
  });

  it('cancel_reminder with nonexistent ID: error REMINDER_NOT_FOUND', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'cancel_reminder', id: 'no-such-id' }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('REMINDER_NOT_FOUND');
    ws.close();
  });

  it('test 21: WS remind recurring with tz', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const before = Date.now();
    ws.send(JSON.stringify({ type: 'remind', text: 'standup', when: '0 9 * * 1', recurring: true, tz: 'Australia/Adelaide' }));
    const ack = await col.wait(m => m.type === 'ack');
    const expected = cronNextTz('0 9 * * 1', before, 'Australia/Adelaide')!;
    expect(Math.abs(ack.due_at - expected)).toBeLessThanOrEqual(60_000);
    const rem = getReminder(db, ack.reminder_id)!;
    expect(rem.tz).toBe('Australia/Adelaide');
    ws.close();
  });

  it('test 22: WS remind invalid tz → INVALID_TZ, no reminder inserted', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '0 9 * * 1', recurring: true, tz: 'Bogus/Zone' }));
    const err = await col.wait(m => m.type === 'error');
    expect(err.code).toBe('INVALID_TZ');
    expect(listAgentReminders(db, 'a1').length).toBe(0);
    ws.close();
  });

  it('test 23: WS remind one-shot DURATION + tz → absolute (no-op)', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const before = Date.now();
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '2s', tz: 'Australia/Adelaide' }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.due_at).toBeGreaterThanOrEqual(before + 1900);
    expect(ack.due_at).toBeLessThanOrEqual(Date.now() + 2100);
    expect(getReminder(db, ack.reminder_id)!.tz).toBe('Australia/Adelaide');
    ws.close();
  });

  it('test 24: WS remind one-shot BARE-ISO + tz → wall-clock in tz', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '2026-06-22T09:00:00', tz: 'Australia/Adelaide' }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.due_at).toBe(wallTimeToUtc(2026, 5, 22, 9, 0, 'Australia/Adelaide'));
    expect(ack.due_at).toBe(Date.UTC(2026, 5, 21, 23, 30, 0));
    expect(ack.due_at).not.toBe(Date.parse('2026-06-22T09:00:00'));
    expect(getReminder(db, ack.reminder_id)!.tz).toBe('Australia/Adelaide');
    ws.close();
  });

  it('test 25: WS remind one-shot ZONED-ISO + tz → absolute (no-op)', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '2026-06-22T09:00:00Z', tz: 'Australia/Adelaide' }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.due_at).toBe(Date.parse('2026-06-22T09:00:00Z'));
    expect(getReminder(db, ack.reminder_id)!.tz).toBe('Australia/Adelaide');
    ws.close();
  });

  it('test 38: remind WITH msg_id → ack ref === msg_id, body intact', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    const before = Date.now();
    ws.send(JSON.stringify({ type: 'remind', msg_id: 'm-1', text: 'x', when: '2s' }));
    const ack = await col.wait(m => m.type === 'ack');
    expect(ack.ref).toBe('m-1');
    expect(ack.ok).toBe(true);
    expect(typeof ack.reminder_id).toBe('string');
    expect(ack.due_at).toBeGreaterThanOrEqual(before + 1900);
    expect(ack.due_at).toBeLessThanOrEqual(Date.now() + 2100);
    ws.close();
  });

  it('test 39: remind WITHOUT msg_id → ack omits ref, body intact', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '2s' }));
    const ack = await col.wait(m => m.type === 'ack');
    expect('ref' in ack).toBe(false);
    expect(typeof ack.reminder_id).toBe('string');
    expect(typeof ack.due_at).toBe('number');
    ws.close();
  });

  it('test 40: cancel_reminder WITH msg_id → ack ref === msg_id', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '1h' }));
    const ack = await col.wait(m => m.type === 'ack');
    ws.send(JSON.stringify({ type: 'cancel_reminder', msg_id: 'c-7', id: ack.reminder_id }));
    const cancelAck = await col.wait(m => m.type === 'ack' && m.ref === 'c-7');
    expect(cancelAck.ok).toBe(true);
    ws.send(JSON.stringify({ type: 'list_reminders' }));
    const list = await col.wait(m => m.type === 'reminders_list');
    expect(list.reminders.find((r: any) => r.id === ack.reminder_id)).toBeUndefined();
    ws.close();
  });

  it('test 41: error frames carry ref === msg_id (remind + cancel)', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', msg_id: 'e-3', text: 'x', when: 'not-a-time' }));
    const err1 = await col.wait(m => m.type === 'error');
    expect(err1.code).toBe('INVALID_WHEN');
    expect(err1.ref).toBe('e-3');

    ws.send(JSON.stringify({ type: 'cancel_reminder', msg_id: 'e-4', id: 'nonexistent' }));
    const err2 = await col.wait(m => m.type === 'error' && m.ref === 'e-4');
    expect(err2.code).toBe('REMINDER_NOT_FOUND');
    ws.close();
  });
});

// ──────────────────────────────────────────────
// HTTP admin endpoint tests
// ──────────────────────────────────────────────

describe('reminder HTTP admin endpoints', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const token = 'test-admin-token';
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    handle = await startHttpAdmin(0, db, token, 10_485_760, filesDir, new Map());
    const port = (handle.server.address() as net.AddressInfo).port;
    base = `http://localhost:${port}`;
    registerAgent(db, { id: 'agentA', token_hash: 'a'.repeat(64), hostname: 'h1' });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  function post(body: unknown) {
    return fetch(`${base}/reminders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function patch(id: string, body: unknown) {
    return fetch(`${base}/reminders/${id}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('POST with duration "2s": 201 + full Reminder, one-shot, due_at ~ now+2000', async () => {
    const before = Date.now();
    const res = await post({ agent_id: 'agentA', payload: 'hi', duration: '2s' });
    expect(res.status).toBe(201);
    const r = await res.json() as any;
    expect(r.agent_id).toBe('agentA');
    expect(r.schedule).toBe(null);
    expect(r.status).toBe('pending');
    expect(r.due_at).toBeGreaterThanOrEqual(before + 1900);
    expect(r.due_at).toBeLessThanOrEqual(Date.now() + 2100);
  });

  it('POST with absolute due_at: 201, one-shot, returned due_at equals supplied', async () => {
    const future = Date.now() + 3_600_000;
    const res = await post({ agent_id: 'agentA', payload: 'hi', due_at: future });
    expect(res.status).toBe(201);
    const r = await res.json() as any;
    expect(r.due_at).toBe(future);
    expect(r.schedule).toBe(null);
  });

  it('POST with schedule "0 9 * * 1": 201, schedule set, due_at = next Monday 09:00 UTC', async () => {
    const before = Date.now();
    const res = await post({ agent_id: 'agentA', payload: 'weekly', schedule: '0 9 * * 1' });
    expect(res.status).toBe(201);
    const r = await res.json() as any;
    expect(r.schedule).toBe('0 9 * * 1');
    const expected = cronNext('0 9 * * 1', before)!;
    expect(Math.abs(r.due_at - expected)).toBeLessThanOrEqual(60_000);
    const d = new Date(r.due_at);
    expect(d.getUTCDay()).toBe(1);
    expect(d.getUTCHours()).toBe(9);
  });

  it('POST with unknown agent_id: 404', async () => {
    const res = await post({ agent_id: 'nope', payload: 'hi', duration: '2s' });
    expect(res.status).toBe(404);
    const r = await res.json() as any;
    expect(r.error).toBe('agent not found');
  });

  it('POST with missing payload: 400', async () => {
    const res = await post({ agent_id: 'agentA', duration: '2s' });
    expect(res.status).toBe(400);
  });

  it('POST with empty payload: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: '', duration: '2s' });
    expect(res.status).toBe(400);
  });

  it('POST with zero timing fields: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'hi' });
    expect(res.status).toBe(400);
  });

  it('POST with more than one timing field: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'hi', duration: '2s', due_at: Date.now() + 100000 });
    expect(res.status).toBe(400);
  });

  it('POST with past due_at: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'hi', due_at: Date.now() - 1000 });
    expect(res.status).toBe(400);
  });

  it('POST with invalid schedule cron: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'hi', schedule: '99 * * * *' });
    expect(res.status).toBe(400);
  });

  it('POST with unparseable/zero duration: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'hi', duration: '0s' });
    expect(res.status).toBe(400);
  });

  it('POST with oversized payload: 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'x'.repeat(4097), duration: '2s' });
    expect(res.status).toBe(400);
  });

  it('GET /reminders?agent_id=X: returns list', async () => {
    await post({ agent_id: 'agentA', payload: 'hi', duration: '1h' });
    const res = await fetch(`${base}/reminders?agent_id=agentA`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    expect(list.length).toBe(1);
    expect(list[0].payload).toBe('hi');
  });

  it('GET /reminders with unknown agent: 404', async () => {
    const res = await fetch(`${base}/reminders?agent_id=nope`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('GET /reminders with no agent_id: 200 + all pending reminders across agents', async () => {
    registerAgent(db, { id: 'agentB', token_hash: 'b'.repeat(64), hostname: 'h2' });
    await post({ agent_id: 'agentA', payload: 'from A', duration: '1h' });
    await post({ agent_id: 'agentB', payload: 'from B', duration: '2h' });
    const res = await fetch(`${base}/reminders`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    expect(list.length).toBe(2);
    // Each row carries agent_id + the dashboard fields, ordered by due_at.
    const byAgent = Object.fromEntries(list.map((r) => [r.agent_id, r]));
    expect(byAgent['agentA'].payload).toBe('from A');
    expect(byAgent['agentB'].payload).toBe('from B');
    for (const r of list) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('due_at');
      expect(r).toHaveProperty('schedule');
      expect(r).toHaveProperty('status');
      expect(r).toHaveProperty('created_at');
      expect(r).toHaveProperty('last_fired_at');
      expect(r).toHaveProperty('tz');
    }
  });

  it('DELETE /reminders/:id: 200 + reminder no longer listed', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', duration: '1h' })).json() as any;
    const res = await fetch(`${base}/reminders/${created.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const list = await (await fetch(`${base}/reminders?agent_id=agentA`, { headers: { 'Authorization': `Bearer ${token}` } })).json() as any[];
    expect(list.length).toBe(0);
  });

  it('DELETE /reminders/:id for nonexistent: 404', async () => {
    const res = await fetch(`${base}/reminders/no-such`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it('PATCH payload only: updates payload, leaves schedule/due_at unchanged', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'orig', duration: '1h' })).json() as any;
    const res = await patch(created.id, { payload: 'edited' });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.payload).toBe('edited');
    expect(updated.schedule).toBe(null);
    expect(updated.due_at).toBe(created.due_at);
    expect(updated.status).toBe('pending');
  });

  it('PATCH duration: recomputes due_at, becomes one-shot', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', schedule: '0 9 * * 1' })).json() as any;
    const before = Date.now();
    const res = await patch(created.id, { duration: '30m' });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.schedule).toBe(null);
    expect(updated.due_at).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
    expect(updated.due_at).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);
  });

  it('PATCH schedule on a one-shot: becomes recurring, due_at recomputed', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', duration: '1h' })).json() as any;
    expect(created.schedule).toBe(null);
    const res = await patch(created.id, { schedule: '0 9 * * 1' });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.schedule).toBe('0 9 * * 1');
    // next Monday 09:00 UTC, strictly in the future
    expect(updated.due_at).toBeGreaterThan(Date.now());
  });

  it('PATCH tz on a cron reminder: recomputes due_at in the new tz', async () => {
    // create a weekly cron in UTC, then switch to Adelaide → due_at must shift
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', schedule: '0 9 * * 1' })).json() as any;
    expect(created.tz).toBe(null);
    const res = await patch(created.id, { tz: 'Australia/Adelaide' });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.tz).toBe('Australia/Adelaide');
    expect(updated.schedule).toBe('0 9 * * 1');
    // Adelaide 09:00 != UTC 09:00, so the recomputed instant differs from the UTC one
    expect(updated.due_at).not.toBe(created.due_at);
    expect(updated.due_at).toBeGreaterThan(Date.now());
  });

  it('PATCH due_at to convert a cron reminder to a one-shot', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', schedule: '0 9 * * 1' })).json() as any;
    const future = Date.now() + 3_600_000;
    const res = await patch(created.id, { due_at: future });
    expect(res.status).toBe(200);
    const updated = await res.json() as any;
    expect(updated.schedule).toBe(null);
    expect(updated.due_at).toBe(future);
  });

  it('PATCH with more than one when-field: 400', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', duration: '1h' })).json() as any;
    const res = await patch(created.id, { duration: '2h', due_at: Date.now() + 100000 });
    expect(res.status).toBe(400);
  });

  it('PATCH with past due_at: 400', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', duration: '1h' })).json() as any;
    const res = await patch(created.id, { due_at: Date.now() - 1000 });
    expect(res.status).toBe(400);
  });

  it('PATCH with invalid tz: 400', async () => {
    const created = await (await post({ agent_id: 'agentA', payload: 'hi', duration: '1h' })).json() as any;
    const res = await patch(created.id, { tz: 'Mars/Olympus' });
    expect(res.status).toBe(400);
  });

  it('PATCH nonexistent id: 404', async () => {
    const res = await patch('no-such', { payload: 'x' });
    expect(res.status).toBe(404);
  });

  it('test 26: POST recurring with tz → 201, tz set, due_at = cronNextTz', async () => {
    const before = Date.now();
    const res = await post({ agent_id: 'agentA', payload: 'weekly', schedule: '0 9 * * 1', tz: 'Australia/Adelaide' });
    expect(res.status).toBe(201);
    const r = await res.json() as any;
    expect(r.tz).toBe('Australia/Adelaide');
    const expected = cronNextTz('0 9 * * 1', before, 'Australia/Adelaide')!;
    expect(Math.abs(r.due_at - expected)).toBeLessThanOrEqual(60_000);
  });

  it('test 27: POST invalid tz → 400', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'x', schedule: '0 9 * * 1', tz: 'Bogus/Zone' });
    expect(res.status).toBe(400);
    const r = await res.json() as any;
    expect(r.error).toBe('invalid IANA timezone');
  });

  it('test 28: POST no tz == UTC (regression)', async () => {
    const before = Date.now();
    const res = await post({ agent_id: 'agentA', payload: 'weekly', schedule: '0 9 * * 1' });
    expect(res.status).toBe(201);
    const r = await res.json() as any;
    expect(r.tz).toBe(null);
    const expected = cronNext('0 9 * * 1', before)!;
    expect(Math.abs(r.due_at - expected)).toBeLessThanOrEqual(60_000);
  });

  it('test 29: POST one-shot BARE-ISO due_at + tz → wall-clock in tz', async () => {
    const res = await post({ agent_id: 'agentA', payload: 'x', due_at: '2026-06-22T09:00:00', tz: 'Australia/Adelaide' });
    expect(res.status).toBe(201);
    const r = await res.json() as any;
    expect(r.tz).toBe('Australia/Adelaide');
    expect(r.due_at).toBe(Date.UTC(2026, 5, 21, 23, 30, 0));
    expect(r.due_at).not.toBe(Date.parse('2026-06-22T09:00:00'));
  });
});

// ──────────────────────────────────────────────
// Integration / success criteria tests
// ──────────────────────────────────────────────

describe('reminder integration / success criteria', () => {
  let db: Database;
  let wsHandle: WsServerHandle;
  let port: number;
  let filesDir: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
    wsHandle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    await wsHandle.shutdown().catch(() => {});
    db.close();
  });

  it('A — one-shot fires within window', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'wake up', when: '2s' }));
    await col.wait(m => m.type === 'ack');

    await new Promise(r => setTimeout(r, 2200));
    const sched = startReminderScheduler(db, wsHandle.agentIndex, 999999);
    sched.tick();
    sched.stop();

    const deliver = await col.wait(m => m.type === 'deliver' && m.kind === 'reminder');
    expect(deliver.payload).toBe('wake up');
    ws.close();
  }, 10000);

  it('B — cron fires 2+ times', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'tick', when: '* * * * *', recurring: true }));
    const ack = await col.wait(m => m.type === 'ack');
    const remId = ack.reminder_id;

    const sched = startReminderScheduler(db, wsHandle.agentIndex, 999999);

    // Force due in the past, fire #1
    updateReminderDueAt(db, remId, Date.now() - 1000, Date.now());
    sched.tick();
    await col.wait(m => m.type === 'deliver' && m.kind === 'reminder');

    // Reset due into the past again, fire #2
    updateReminderDueAt(db, remId, Date.now() - 1000, Date.now());
    sched.tick();
    await col.wait(m => m.type === 'deliver' && m.kind === 'reminder');

    sched.stop();
    const cnt = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE to_agent = ? AND kind = ?').get('a1', 'reminder') as { cnt: number };
    expect(cnt.cnt).toBeGreaterThanOrEqual(2);
    ws.close();
  }, 10000);

  it('C — survives server restart (file-backed DB close+reopen)', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'mesh-restart-'));
    const dbPath = join(dbDir, `mesh-${randomBytes(6).toString('hex')}.db`);
    let fdb = openDb(dbPath);
    registerAgent(fdb, { id: 'a1', token_hash: 'a'.repeat(64), hostname: 'h' });
    insertReminder(fdb, { id: 'r1', agent_id: 'a1', due_at: Date.now() - 1000, schedule: null, payload: 'survive', created_at: Date.now() });
    fdb.close();

    // Reopen — new connection, new scheduler
    fdb = openDb(dbPath);
    expect(getReminder(fdb, 'r1')).not.toBe(null);
    const sched = startReminderScheduler(fdb, new Map() as any, 999999);
    sched.tick();
    sched.stop();

    const cnt = fdb.prepare('SELECT COUNT(*) as cnt FROM messages WHERE to_agent = ?').get('a1') as { cnt: number };
    expect(cnt.cnt).toBe(1);
    expect(getReminder(fdb, 'r1')!.status).toBe('delivered');
    fdb.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('D — survives agent redeploy (disconnect, tick queues, reconnect delivers)', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'a1', token_hash: hashToken(rawToken), hostname: 'h' });
    insertReminder(db, { id: 'r1', agent_id: 'a1', due_at: Date.now() - 1000, schedule: null, payload: 'redeploy', created_at: Date.now() });

    // agent offline → tick queues
    const sched = startReminderScheduler(db, wsHandle.agentIndex, 999999);
    sched.tick();
    sched.stop();
    const msgRow = db.prepare('SELECT * FROM messages WHERE to_agent = ?').get('a1') as any;
    expect(msgRow.delivered_at).toBe(null);

    // agent reconnects → drainQueue delivers
    const ws = await connectWs(port);
    const col = makeCollector(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'a1', token: rawToken }));
    await col.wait(m => m.type === 'auth_ok');
    const deliver = await col.wait(m => m.type === 'deliver' && m.kind === 'reminder');
    expect(deliver.payload).toBe('redeploy');
    ws.close();
  }, 10000);

  it('E — offline agent receives on reconnect', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'a1', token_hash: hashToken(rawToken), hostname: 'h' });
    insertReminder(db, { id: 'r1', agent_id: 'a1', due_at: Date.now() - 1000, schedule: null, payload: 'offline-deliver', created_at: Date.now() });

    const sched = startReminderScheduler(db, wsHandle.agentIndex, 999999);
    sched.tick();
    sched.stop();

    const ws = await connectWs(port);
    const col = makeCollector(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'a1', token: rawToken }));
    await col.wait(m => m.type === 'auth_ok');
    const deliver = await col.wait(m => m.type === 'deliver' && m.kind === 'reminder');
    expect(deliver.payload).toBe('offline-deliver');
    ws.close();
  }, 10000);

  it('F — list + cancel: 3 reminders, cancel 1, list shows 2, tick fires only 2', async () => {
    const { ws, col } = await authConnect(port, db, 'a1');
    ws.send(JSON.stringify({ type: 'remind', text: 'one', when: '1h' }));
    const a1 = await col.wait(m => m.type === 'ack');
    ws.send(JSON.stringify({ type: 'remind', text: 'two', when: '1h' }));
    await col.wait(m => m.type === 'ack');
    ws.send(JSON.stringify({ type: 'remind', text: 'three', when: '1h' }));
    await col.wait(m => m.type === 'ack');

    ws.send(JSON.stringify({ type: 'list_reminders' }));
    const list1 = await col.wait(m => m.type === 'reminders_list');
    expect(list1.reminders.length).toBe(3);

    ws.send(JSON.stringify({ type: 'cancel_reminder', msg_id: 'cx-F', id: a1.reminder_id }));
    await col.wait(m => m.type === 'ack' && m.ref === 'cx-F');

    ws.send(JSON.stringify({ type: 'list_reminders' }));
    const list2 = await col.wait(m => m.type === 'reminders_list');
    expect(list2.reminders.length).toBe(2);

    // Force the two remaining due, tick fires only 2
    db.prepare("UPDATE reminders SET due_at = ? WHERE status = 'pending'").run(Date.now() - 1000);
    const sched = startReminderScheduler(db, wsHandle.agentIndex, 999999);
    sched.tick();
    sched.stop();

    const cnt = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE to_agent = ? AND kind = ?').get('a1', 'reminder') as { cnt: number };
    expect(cnt.cnt).toBe(2);
    ws.close();
  }, 10000);
});
