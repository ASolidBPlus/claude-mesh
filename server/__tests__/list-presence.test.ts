import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant, setOnline, getAgentById } from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let portCounter = 19800;
function nextPort() { return portCounter++; }

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function makeCollector(ws: WebSocket) {
  const queue: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); return; }
    }
    queue.push(m);
  });
  return {
    wait(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
      for (let i = 0; i < queue.length; i++) {
        if (pred(queue[i])) return Promise.resolve(queue.splice(i, 1)[0]);
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

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('error', reject);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => ws.once('close', (code) => resolve({ code })));
}

describe('list_presence', () => {
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

  it('test 30: ACL peer included, correct fields', async () => {
    // Register B with a known DB online/last_seen.
    registerAgent(db, { id: 'B', token_hash: 'b'.repeat(64), hostname: 'hB' });
    setOnline(db, 'B', true);
    const bRow = getAgentById(db, 'B')!;

    const { ws, col } = await authConnect(port, db, 'A');
    aclGrant(db, 'A', 'B', 'system');

    ws.send(JSON.stringify({ type: 'list_presence' }));
    const resp = await col.wait(m => m.type === 'presence_list');
    const byId: Record<string, any> = {};
    for (const a of resp.agents) byId[a.id] = a;

    expect(byId['A']).toBeDefined();
    expect(byId['A'].online).toBe(true);
    expect(byId['B']).toBeDefined();
    expect(byId['B'].online).toBe(bRow.online === 1);
    expect(byId['B'].last_seen).toBe(bRow.last_seen);
    ws.close();
  });

  it('test 31: no ACL → only self', async () => {
    registerAgent(db, { id: 'X', token_hash: 'x'.repeat(64), hostname: 'hX' });
    registerAgent(db, { id: 'Y', token_hash: 'y'.repeat(64), hostname: 'hY' });

    const { ws, col } = await authConnect(port, db, 'C');
    ws.send(JSON.stringify({ type: 'list_presence' }));
    const resp = await col.wait(m => m.type === 'presence_list');
    expect(resp.agents.length).toBe(1);
    expect(resp.agents[0].id).toBe('C');
    ws.close();
  });

  it('test 32: online/last_seen reflect DB', async () => {
    registerAgent(db, { id: 'D', token_hash: 'd'.repeat(64), hostname: 'hD' });
    setOnline(db, 'D', true);

    const { ws, col } = await authConnect(port, db, 'A');
    aclGrant(db, 'A', 'D', 'system');

    ws.send(JSON.stringify({ type: 'list_presence' }));
    const r1 = await col.wait(m => m.type === 'presence_list');
    expect(r1.agents.find((a: any) => a.id === 'D').online).toBe(true);

    setOnline(db, 'D', false);
    ws.send(JSON.stringify({ type: 'list_presence' }));
    const r2 = await col.wait(m => m.type === 'presence_list');
    expect(r2.agents.find((a: any) => a.id === 'D').online).toBe(false);
    ws.close();
  });

  it('test 33: pre-auth list_presence rejected', async () => {
    const ws = await connectWs(port);
    const replyP = waitForMessage(ws);
    const closeP = waitForClose(ws);
    ws.send(JSON.stringify({ type: 'list_presence' }));
    const reply = JSON.parse(await replyP);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('AUTH_REQUIRED');
    const { code } = await closeP;
    expect(code).toBe(1008);
  });

  it('test 34: list_presence WITH msg_id echoes ref', async () => {
    registerAgent(db, { id: 'B2', token_hash: 'b'.repeat(64), hostname: 'hB' });
    const { ws, col } = await authConnect(port, db, 'A');
    aclGrant(db, 'A', 'B2', 'system');

    ws.send(JSON.stringify({ type: 'list_presence', msg_id: 'q-1' }));
    const resp = await col.wait(m => m.type === 'presence_list');
    expect(resp.ref).toBe('q-1');
    expect(resp.agents.length).toBeGreaterThanOrEqual(2);
    ws.close();
  });

  it('test 35: list_presence WITHOUT msg_id omits ref', async () => {
    const { ws, col } = await authConnect(port, db, 'A');
    ws.send(JSON.stringify({ type: 'list_presence' }));
    const resp = await col.wait(m => m.type === 'presence_list');
    expect('ref' in resp).toBe(false);
    expect(Array.isArray(resp.agents)).toBe(true);
    ws.close();
  });

  it('test 36: list_reminders WITH msg_id echoes ref', async () => {
    const { ws, col } = await authConnect(port, db, 'A');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '1h' }));
    await col.wait(m => m.type === 'ack');

    ws.send(JSON.stringify({ type: 'list_reminders', msg_id: 'r-9' }));
    const resp = await col.wait(m => m.type === 'reminders_list');
    expect(resp.ref).toBe('r-9');
    expect(resp.reminders.length).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  it('test 37: list_reminders WITHOUT msg_id omits ref', async () => {
    const { ws, col } = await authConnect(port, db, 'A');
    ws.send(JSON.stringify({ type: 'remind', text: 'x', when: '1h' }));
    await col.wait(m => m.type === 'ack');

    ws.send(JSON.stringify({ type: 'list_reminders' }));
    const resp = await col.wait(m => m.type === 'reminders_list');
    expect('ref' in resp).toBe(false);
    expect(resp.reminders.length).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});
