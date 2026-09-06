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
  // (removed) 'request/response round-trip' + 'request timeout' — tested the
  // removed native request/response primitive; deleted per the operator's strip.

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

  // (removed) 'request to a no-ACL agent rejects quickly with ACL_DENIED' —
  // tested the removed native request primitive; deleted per the operator's strip.
  // (ACL fast-fail is still covered for directs by 'ACL-denied send rejects…'.)

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

// F4 — `origin` on an inbound topic delivery.
//
// It says which mesh and agent a federated post came from, and it is DISPLAY
// ONLY: the SDK surfaces it and attaches no meaning. `from` remains the
// principal the message is attributed to (`orch:trollbox`); `origin` is the
// speaker behind it (`pod1:alice`). A consumer that routed on it would be
// trusting a string another mesh chose.
describe('F4 Inbound.origin', () => {
  // A local harness rather than the file's shared one: these two need the
  // agentIndex to push a hand-built deliver frame, which is the only way to
  // exercise a field the server sets on a path this suite cannot drive.
  const startTestServer = async () => {
    const db = openDb(':memory:');
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'f4-origin-')));
    return { db, handle, port };
  };

  it('surfaces origin when the frame carries it, and null when it does not', async () => {
    const { db, handle, port } = await startTestServer();
    try {
      registerAgent(db, { id: 'sub', token_hash: hashToken('tok'), hostname: 'h' });
      const client = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'sub', agentToken: 'tok' });
      const seen: Inbound[] = [];
      client.onMessage((m) => { seen.push(m); });
      await client.connect();

      const sock = handle.agentIndex.get('sub')!;
      sock.send(JSON.stringify({
        type: 'deliver', msg_id: 'm1', kind: 'topic', from: 'orch:trollbox', to: null,
        topic: 'orch:trollbox', correlation_id: null, payload: 'hi',
        content_type: 'text/plain', sent_at: Date.now(), origin: 'pod1:alice',
      }));
      sock.send(JSON.stringify({
        type: 'deliver', msg_id: 'm2', kind: 'direct', from: 'other', to: 'sub',
        topic: null, correlation_id: null, payload: 'hi',
        content_type: 'text/plain', sent_at: Date.now(), origin: null,
      }));
      await new Promise(r => setTimeout(r, 200));

      expect(seen.map(m => [m.msgId, m.origin])).toEqual([
        ['m1', 'pod1:alice'],
        ['m2', null],
      ]);
      // `from` is untouched: origin is beside it, never instead of it.
      expect(seen[0]!.from).toBe('orch:trollbox');
      client.close();
    } finally {
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('a frame with no origin key at all surfaces null, not undefined', async () => {
    const { db, handle, port } = await startTestServer();
    try {
      registerAgent(db, { id: 'sub', token_hash: hashToken('tok'), hostname: 'h' });
      const client = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'sub', agentToken: 'tok' });
      const seen: Inbound[] = [];
      client.onMessage((m) => { seen.push(m); });
      await client.connect();

      // Every pre-F4 sender omits the key entirely. `null` is the honest
      // answer for "this did not cross a border"; `undefined` would make a
      // consumer's `'origin' in m` check disagree with its `m.origin === null`
      // check.
      handle.agentIndex.get('sub')!.send(JSON.stringify({
        type: 'deliver', msg_id: 'm3', kind: 'direct', from: 'other', to: 'sub',
        topic: null, correlation_id: null, payload: 'hi',
        content_type: 'text/plain', sent_at: Date.now(),
      }));
      await new Promise(r => setTimeout(r, 200));

      expect(seen.length).toBe(1);
      expect(seen[0]!.origin).toBe(null);
      client.close();
    } finally {
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});
