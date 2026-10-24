// R-335 — at-least-once delivery for clients that opt in.
//
// The reproduction: the bus drained an agent's queue to a socket that closed
// before the client read it, set delivered_at on write, and never sent the
// rows again. An agent whose auth frame carries capabilities:['ack'] now gets
// its delivered-but-unacked rows again on its next login (redelivered:true),
// within MESH_REDELIVERY_WINDOW_MS and their TTL. A client without the
// capability gets exactly the old behaviour. Only a row's recipient may ack it.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, aclGrant, insertMessage, deleteAgent } from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { routeDirect } from '../router.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 24300;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Frame = { type: string; msg_id?: string; redelivered?: boolean; code?: string; payload?: string };

/** A raw agent socket that records every frame after auth_ok. */
async function login(port: number, agentId: string, token: string, capabilities?: unknown): Promise<{ ws: WebSocket; frames: Frame[]; authReply: Frame }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const frames: Frame[] = [];
  const authReply = await new Promise<Frame>((resolve) => {
    let first = true;
    ws.on('message', (data) => {
      const f = JSON.parse(data.toString()) as Frame;
      if (first) { first = false; resolve(f); return; }
      frames.push(f);
    });
    ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token, ...(capabilities === undefined ? {} : { capabilities }) }));
  });
  await delay(60);   // let the drain land
  return { ws, frames, authReply };
}

async function logout(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(); });
  await delay(30);
}

const delivers = (frames: Frame[]) => frames.filter(f => f.type === 'deliver');

describe('R-335 at-least-once delivery', () => {
  let db: Database;
  let handle: WsServerHandle | undefined;
  let port: number;
  let tokA: string;
  let tokB: string;
  let tokC: string;

  async function start(redeliveryWindowMs?: number): Promise<void> {
    port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, tmp('r335-files-'), 0, new Map(), null,
      redeliveryWindowMs === undefined ? {} : { redeliveryWindowMs });
  }

  /** B sends A `n` messages while A is offline, so they queue. */
  function queueForA(n: number, prefix = 'm'): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${i}`;
      expect(routeDirect(db, new Map(), 'B', { type: 'send', msg_id: id, to: 'A', payload: `${prefix}${i}` }).ok).toBe(true);
      ids.push(id);
    }
    return ids;
  }

  beforeEach(() => {
    db = openDb(':memory:');
    tokA = generateToken(); tokB = generateToken(); tokC = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokB), hostname: 'hB' });
    registerAgent(db, { id: 'C', token_hash: hashToken(tokC), hostname: 'hC' });
    aclGrant(db, 'B', 'A', 'system');
  });
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    handle = undefined;
    db.close();
  });

  it('REPRODUCTION: rows drained to a socket that closed unread come back on the next ack-capable login', async () => {
    await start();
    const ids = queueForA(3);
    const first = await login(port, 'A', tokA, ['ack']);
    expect(delivers(first.frames).map(f => f.msg_id)).toEqual(ids);
    expect(delivers(first.frames).every(f => f.redelivered === undefined)).toBe(true);
    // The client never got to read them: no ack, socket gone.
    await logout(first.ws);
    const rows = db.prepare("SELECT delivered_at, acked_at FROM messages WHERE to_agent = 'A'").all() as { delivered_at: number | null; acked_at: number | null }[];
    expect(rows.every(r => r.delivered_at !== null && r.acked_at === null)).toBe(true);

    const second = await login(port, 'A', tokA, ['ack']);
    expect(delivers(second.frames).map(f => f.msg_id)).toEqual(ids);
    expect(delivers(second.frames).every(f => f.redelivered === true)).toBe(true);
    await logout(second.ws);
  });

  it('an ack clears redelivery', async () => {
    await start();
    const ids = queueForA(3);
    const first = await login(port, 'A', tokA, ['ack']);
    first.ws.send(JSON.stringify({ type: 'ack', msg_id: ids[0] }));
    first.ws.send(JSON.stringify({ type: 'ack', msg_id: ids[2] }));
    await delay(40);
    await logout(first.ws);
    const second = await login(port, 'A', tokA, ['ack']);
    expect(delivers(second.frames).map(f => f.msg_id)).toEqual([ids[1]]);
    await logout(second.ws);
  });

  it('a client without the capability gets exactly the old behaviour', async () => {
    await start();
    const ids = queueForA(2);
    const first = await login(port, 'A', tokA);
    expect(delivers(first.frames).map(f => f.msg_id)).toEqual(ids);
    expect(first.frames.every(f => !('redelivered' in f))).toBe(true);
    await logout(first.ws);
    const second = await login(port, 'A', tokA);
    expect(delivers(second.frames)).toEqual([]);
    await logout(second.ws);
    // Unknown capability names are ignored: still not ack-capable.
    const third = await login(port, 'A', tokA, ['something-else']);
    expect(third.authReply.type).toBe('auth_ok');
    expect(delivers(third.frames)).toEqual([]);
    await logout(third.ws);
  });

  it('ACCESS CONTROL: a third party cannot ack another agent\'s row', async () => {
    await start();
    const ids = queueForA(2);
    const a1 = await login(port, 'A', tokA, ['ack']);
    await logout(a1.ws);
    // C knows the ids and acks them; it is not their recipient.
    const c = await login(port, 'C', tokC, ['ack']);
    for (const id of ids) c.ws.send(JSON.stringify({ type: 'ack', msg_id: id }));
    // B, the SENDER, can't ack them either.
    const b = await login(port, 'B', tokB, ['ack']);
    for (const id of ids) b.ws.send(JSON.stringify({ type: 'ack', msg_id: id }));
    await delay(40);
    await logout(c.ws);
    await logout(b.ws);
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE acked_at IS NOT NULL").get() as { n: number }).n).toBe(0);
    const a2 = await login(port, 'A', tokA, ['ack']);
    expect(delivers(a2.frames).map(f => f.msg_id)).toEqual(ids);
    // Positive control: the recipient's own ack does land.
    a2.ws.send(JSON.stringify({ type: 'ack', msg_id: ids[0] }));
    await delay(40);
    expect((db.prepare('SELECT acked_at FROM messages WHERE id = ?').get(ids[0]!) as { acked_at: number | null }).acked_at).not.toBeNull();
    await logout(a2.ws);
  });

  it('a live delivery to an online ack-capable client that is never acked comes back on the next login', async () => {
    await start();
    const a1 = await login(port, 'A', tokA, ['ack']);
    expect(routeDirect(db, handle!.agentIndex, 'B', { type: 'send', msg_id: 'live-1', to: 'A', payload: 'live' }).ok).toBe(true);
    await delay(40);
    expect(delivers(a1.frames).map(f => f.msg_id)).toEqual(['live-1']);
    await logout(a1.ws);
    const a2 = await login(port, 'A', tokA, ['ack']);
    expect(delivers(a2.frames).map(f => [f.msg_id, f.redelivered])).toEqual([['live-1', true]]);
    await logout(a2.ws);
  });

  it('new and redelivered rows drain together in sent_at order, and redelivery does not move delivered_at', async () => {
    await start();
    insertMessage(db, { id: 'old-1', kind: 'direct', from_agent: 'B', to_agent: 'A', payload: 'o1', sent_at: Date.now() - 3000, expires_at: null });
    insertMessage(db, { id: 'old-2', kind: 'direct', from_agent: 'B', to_agent: 'A', payload: 'o2', sent_at: Date.now() - 1000, expires_at: null });
    const a1 = await login(port, 'A', tokA, ['ack']);
    await logout(a1.ws);
    const deliveredAt = (db.prepare("SELECT delivered_at FROM messages WHERE id = 'old-1'").get() as { delivered_at: number }).delivered_at;
    insertMessage(db, { id: 'new-1', kind: 'direct', from_agent: 'B', to_agent: 'A', payload: 'n1', sent_at: Date.now() - 2000, expires_at: null });
    await delay(20);
    const a2 = await login(port, 'A', tokA, ['ack']);
    expect(delivers(a2.frames).map(f => [f.msg_id, f.redelivered ?? false])).toEqual([['old-1', true], ['new-1', false], ['old-2', true]]);
    expect((db.prepare("SELECT delivered_at FROM messages WHERE id = 'old-1'").get() as { delivered_at: number }).delivered_at).toBe(deliveredAt);
    await logout(a2.ws);
  });

  it('only rows delivered within the window and not expired are redelivered', async () => {
    await start(60_000);
    const now = Date.now();
    const row = (id: string, deliveredAgo: number, expiresIn: number | null) => {
      insertMessage(db, { id, kind: 'direct', from_agent: 'B', to_agent: 'A', payload: id, sent_at: now - deliveredAgo - 10, expires_at: expiresIn === null ? null : now + expiresIn });
      db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?').run(now - deliveredAgo, id);
    };
    row('in-window', 30_000, null);
    row('outside-window', 120_000, null);           // e.g. an old reminder: never expires
    row('expired', 10_000, -1_000);
    row('in-window-ttl', 10_000, 600_000);
    const a = await login(port, 'A', tokA, ['ack']);
    expect(delivers(a.frames).map(f => f.msg_id)).toEqual(['in-window', 'in-window-ttl']);
    await logout(a.ws);
  });

  it('a deleted agent\'s unacked rows are not redelivered to a new agent recreated under the same id', async () => {
    // A name reused for a short-lived identity (PowerOUT does this) must not
    // inherit the old identity's redeliveries.
    await start();
    queueForA(2);
    const old = await login(port, 'A', tokA, ['ack']);
    expect(delivers(old.frames)).toHaveLength(2);
    await logout(old.ws);
    deleteAgent(db, 'A');
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = 'A' AND acked_at IS NULL").get() as { n: number }).n).toBe(0);
    const tokNew = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokNew), hostname: 'hA2' });
    const fresh = await login(port, 'A', tokNew, ['ack']);
    expect(fresh.authReply.type).toBe('auth_ok');
    expect(delivers(fresh.frames)).toEqual([]);
    await logout(fresh.ws);
  });

  it('a malformed capabilities field is refused at auth; the shape is checked, not the names', async () => {
    await start();
    for (const bad of ['ack', [1], [''], ['x'.repeat(65)], Array(17).fill('ack'), { ack: true }, null]) {
      const r = await login(port, 'A', tokA, bad);
      expect([r.authReply.type, r.authReply.code]).toEqual(['error', 'AUTH_FAILED']);
      r.ws.close();
    }
    const ok = await login(port, 'A', tokA, []);
    expect(ok.authReply.type).toBe('auth_ok');
    await logout(ok.ws);
  });
});
