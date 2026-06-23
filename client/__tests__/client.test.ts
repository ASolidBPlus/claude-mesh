import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { startReminderScheduler } from '../../server/reminder-scheduler.ts';
import { insertReminder } from '../../server/db.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient, Inbound } from '../src/index.ts';

let portCounter = 19500;
function nextPort() { return portCounter++; }

function urlFor(port: number) { return `ws://127.0.0.1:${port}`; }

// Wait until a fresh `connect` event fires (or one already pending). Returns a
// resetter so the same hook can be re-armed for a reconnect.
function makeConnectWaiter(client: MeshClient) {
  let resolveFn: (() => void) | null = null;
  let fired = false;
  client.on('connect', () => {
    fired = true;
    if (resolveFn) { resolveFn(); resolveFn = null; fired = false; }
  });
  return {
    next(): Promise<void> {
      if (fired) { fired = false; return Promise.resolve(); }
      return new Promise<void>((res) => { resolveFn = res; });
    },
  };
}

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

describe('MeshClient', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let filesDir: string;
  const clients: MeshClient[] = [];

  // raw tokens for the test agents
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;

  function newClient(agentId: string, token: string): MeshClient {
    const c = new MeshClient({ serverUrl: urlFor(port), agentId, agentToken: token });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-client-test-'));

    tokenA = generateToken();
    tokenB = generateToken();
    tokenC = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hostA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hostB' });
    registerAgent(db, { id: 'C', token_hash: hashToken(tokenC), hostname: 'hostC' });

    handle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  // 1
  it('connect + auth resolves and fires the connect event', async () => {
    const client = newClient('A', tokenA);
    let connectCount = 0;
    client.on('connect', () => { connectCount++; });
    await client.connect();
    expect(connectCount).toBe(1);
  });

  // 2
  it('onMessage fires for a direct deliver', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);

    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();
    await a.connect();

    await a.send('B', 'hi');

    const msg = await got;
    expect(msg.kind).toBe('direct');
    expect(msg.from).toBe('A');
    expect(msg.text).toBe('hi');
  });

  // 3
  it('send() resolves once the server acks', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    await b.connect();
    await a.connect();

    await expect(a.send('B', 'hi')).resolves.toBeUndefined();
  });

  // 4
  it('publish/subscribe topic flow delivers to subscriber', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);

    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();
    await a.connect();

    await b.subscribe('t'); // resolves on ack
    await a.publish('t', 'x'); // resolves on ack

    const msg = await got;
    expect(msg.kind).toBe('topic');
    expect(msg.topic).toBe('t');
    expect(msg.text).toBe('x');
  });

  // 5
  it('request/response round-trip resolves with the response', async () => {
    aclGrant(db, 'A', 'B', 'system');
    aclGrant(db, 'B', 'A', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);

    b.onMessage((m) => {
      if (m.kind === 'request' && m.correlationId) {
        b.send('A', 'ans', { kind: 'response', correlationId: m.correlationId });
      }
    });
    await b.connect();
    await a.connect();

    const res = await a.request('B', 'q?');
    expect(res.kind).toBe('response');
    expect(res.text).toBe('ans');
  });

  // 6
  it('request timeout rejects when no response comes', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    await b.connect(); // B online but never answers
    await a.connect();

    await expect(a.request('B', 'q?', { timeoutMs: 300 })).rejects.toThrow('request timeout');
  });

  // 7
  it('reconnect re-auths, re-subscribes, and resumes delivery', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);

    const bConnect = makeConnectWaiter(b);
    await b.connect();
    await a.connect();
    await b.subscribe('t');

    // restart the server on the SAME port with the SAME db (agent + ACL survive)
    await handle.shutdown();
    handle = await startWsServer(port, db, 10_485_760, filesDir);

    // wait for B's client to reconnect (next connect event)
    await bConnect.next();
    // and A's client to reconnect so it can publish
    await delay(1500);

    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await a.publish('t', 'again');

    const msg = await got;
    expect(msg.kind).toBe('topic');
    expect(msg.topic).toBe('t');
    expect(msg.text).toBe('again');
  }, 15000);

  // 8
  it('file_deliver normalizes to Inbound{kind:"file"}', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();

    // raw ws sender for A emits one file_send frame
    const raw = new WebSocket(urlFor(port));
    await new Promise<void>((resolve, reject) => {
      raw.once('open', () => resolve());
      raw.once('error', reject);
    });
    const authed = new Promise<void>((resolve) => {
      raw.on('message', (d) => {
        const f = JSON.parse(d.toString());
        if (f.type === 'auth_ok') resolve();
      });
    });
    raw.send(JSON.stringify({ type: 'auth', agent_id: 'A', token: tokenA }));
    await authed;

    const data = Buffer.from('hello file').toString('base64');
    raw.send(JSON.stringify({
      type: 'file_send', msg_id: crypto.randomUUID(), to: 'B',
      filename: 'note.txt', content_type: 'text/plain', data,
    }));

    const msg = await got;
    expect(msg.kind).toBe('file');
    expect(msg.fileId).toBeTruthy();
    expect(msg.filename).toBe('note.txt');
    expect(msg.contentType).toBe('text/plain');
    expect(msg.payload).toBeNull();
    expect(msg.text).toBeNull();

    raw.close();
  });

  // 9
  it('ACL-denied send rejects with err.code === ACL_DENIED', async () => {
    // A and C registered, NO ACL A→C
    const a = newClient('A', tokenA);
    await a.connect();

    let caught: any = null;
    try {
      await a.send('C', 'x');
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('ACL_DENIED');
  });

  // 10
  it('close() stops reconnect; send after close rejects', async () => {
    const a = newClient('A', tokenA);
    let connectCount = 0;
    a.on('connect', () => { connectCount++; });
    await a.connect();
    expect(connectCount).toBe(1);

    a.close();
    await handle.shutdown();

    await delay(600);
    // no reconnect happened
    expect(connectCount).toBe(1);

    await expect(a.send('B', 'x')).rejects.toThrow('not connected');
  });

  // 11 (amendment 4): request to an agent with NO ACL fast-fails on ACL_DENIED,
  // NOT via the 30s timeout.
  it('request to a no-ACL agent rejects quickly with ACL_DENIED', async () => {
    // A → C has no ACL grant
    const a = newClient('A', tokenA);
    await a.connect();

    let caught: any = null;
    const start = Date.now();
    try {
      await a.request('C', 'q?'); // default 30s timeout — must NOT wait that long
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('ACL_DENIED');
    expect(elapsed).toBeLessThan(2000);
  });

  // ── reminders ────────────────────────────────────────────────

  // 12
  it('remind() with a duration resolves { reminderId, dueAt }', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    const before = Date.now();
    const res = await a.remind({ text: 'wake', when: '60s' });
    expect(typeof res.reminderId).toBe('string');
    expect(res.reminderId.length).toBeGreaterThan(0);
    expect(res.dueAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(res.dueAt).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  // 13
  it('remind() with recurring cron + tz resolves with schedule stored', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    const res = await a.remind({
      text: 'standup',
      when: '0 9 * * 1',
      recurring: true,
      tz: 'Australia/Adelaide',
    });
    expect(typeof res.reminderId).toBe('string');
    const list = await a.listReminders();
    const rem = list.find((r) => r.id === res.reminderId);
    expect(rem).toBeDefined();
    expect(rem!.schedule).toBe('0 9 * * 1');
  });

  // 14
  it('remind() with a bad when rejects with INVALID_WHEN', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    let caught: any = null;
    try {
      await a.remind({ text: 'x', when: 'not-a-time' });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('INVALID_WHEN');
  });

  // 15
  it('listReminders() returns a camelCase array; schedule null for one-shot', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    await a.remind({ text: 'one', when: '1h' });
    await a.remind({ text: 'weekly', when: '0 9 * * 1', recurring: true });

    const list = await a.listReminders();
    expect(list.length).toBe(2);
    const oneShot = list.find((r) => r.payload === 'one')!;
    const recurring = list.find((r) => r.payload === 'weekly')!;
    expect(oneShot.schedule).toBeNull();
    expect(typeof oneShot.dueAt).toBe('number');
    expect(typeof oneShot.id).toBe('string');
    expect(typeof oneShot.createdAt).toBe('number');
    expect(oneShot.lastFiredAt).toBeNull();
    expect(recurring.schedule).toBe('0 9 * * 1');
  });

  // 16
  it('cancelReminder() resolves and removes it; nonexistent rejects REMINDER_NOT_FOUND', async () => {
    const a = newClient('A', tokenA);
    await a.connect();
    const r1 = await a.remind({ text: 'one', when: '1h' });
    await a.remind({ text: 'two', when: '2h' });

    await expect(a.cancelReminder(r1.reminderId)).resolves.toBeUndefined();
    const list = await a.listReminders();
    expect(list.find((r) => r.id === r1.reminderId)).toBeUndefined();
    expect(list.length).toBe(1);

    let caught: any = null;
    try {
      await a.cancelReminder('nope');
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe('REMINDER_NOT_FOUND');
  });

  // 17
  it('a fired reminder is received as Inbound{kind:"reminder", from:"mesh"}', async () => {
    const a = newClient('A', tokenA);
    const got = new Promise<Inbound>((resolve) => { a.onMessage(resolve); });
    await a.connect();

    // create a reminder due in the past directly, then tick the scheduler
    insertReminder(db, {
      id: 'fired-1',
      agent_id: 'A',
      due_at: Date.now() - 1000,
      schedule: null,
      payload: 'time to ship',
      created_at: Date.now(),
    });
    const sched = startReminderScheduler(db, handle.agentIndex, 999999);
    sched.tick();
    sched.stop();

    const msg = await got;
    expect(msg.kind).toBe('reminder');
    expect(msg.from).toBe('mesh');
    expect(msg.text).toBe('time to ship');
  });
});
