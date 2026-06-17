import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let portCounter = 19700;
function nextPort() { return portCounter++; }

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()));
    ws.once('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Connect + auth an agent, returning its ws. Does NOT consume any agent_status.
async function authConnect(port: number, token: string, agentId: string): Promise<WebSocket> {
  const ws = await connectWs(port);
  const authP = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token }));
  await authP; // auth_ok
  return ws;
}

describe('presence debounce', () => {
  let db: Database;
  let filesDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-test-'));
  });

  afterEach(() => {
    db.close();
  });

  function setup(): { tokenA: string; tokenB: string } {
    const tokenA = generateToken();
    const tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    aclGrant(db, 'A', 'B', 'system');
    return { tokenA, tokenB };
  }

  it('test 1: drop+reconnect INSIDE window → no churn', async () => {
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, filesDir, 200);
    const { tokenA, tokenB } = setup();
    try {
      const wsB = await authConnect(port, tokenB, 'B');

      // A connects; B consumes A's online.
      const onlineP = waitForMessage(wsB);
      const wsA = await authConnect(port, tokenA, 'A');
      const online = JSON.parse(await onlineP);
      expect(online.type).toBe('agent_status');
      expect(online.online).toBe(true);

      // A closes, reconnects ~50ms later (inside the 200ms window).
      wsA.close();
      await delay(50);
      await authConnect(port, tokenA, 'A');

      // B receives NO further presence frame for A within ~400ms.
      const extra = await Promise.race([
        waitForMessage(wsB),
        delay(400).then(() => null),
      ]);
      expect(extra).toBeNull();
    } finally {
      await handle.shutdown().catch(() => {});
    }
  }, 10000);

  it('test 2: drop, no reconnect → offline after window', async () => {
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, filesDir, 200);
    const { tokenA, tokenB } = setup();
    try {
      const wsB = await authConnect(port, tokenB, 'B');
      const onlineP = waitForMessage(wsB);
      const wsA = await authConnect(port, tokenA, 'A');
      await onlineP;

      const offlineP = waitForMessage(wsB);
      wsA.close();
      const offline = JSON.parse(await offlineP);
      expect(offline.type).toBe('agent_status');
      expect(offline.agent_id).toBe('A');
      expect(offline.online).toBe(false);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  }, 10000);

  it('test 3: drop+reconnect OUTSIDE window → offline then online', async () => {
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, filesDir, 150);
    const { tokenA, tokenB } = setup();
    try {
      const wsB = await authConnect(port, tokenB, 'B');
      const onlineP = waitForMessage(wsB);
      const wsA = await authConnect(port, tokenA, 'A');
      await onlineP;

      // A closes; offline fires after ~150ms; B consumes it.
      const offlineP = waitForMessage(wsB);
      wsA.close();
      const offline = JSON.parse(await offlineP);
      expect(offline.online).toBe(false);

      // THEN A reconnects → fresh online.
      const onlineP2 = waitForMessage(wsB);
      await authConnect(port, tokenA, 'A');
      const online2 = JSON.parse(await onlineP2);
      expect(online2.online).toBe(true);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  }, 10000);

  it('test 4: legacy debounce=0 → immediate offline', async () => {
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const { tokenA, tokenB } = setup();
    try {
      const wsB = await authConnect(port, tokenB, 'B');
      const onlineP = waitForMessage(wsB);
      const wsA = await authConnect(port, tokenA, 'A');
      await onlineP;

      const offlineP = waitForMessage(wsB);
      const t0 = Date.now();
      wsA.close();
      const offline = JSON.parse(await offlineP);
      expect(offline.online).toBe(false);
      // Immediate: well under any debounce window.
      expect(Date.now() - t0).toBeLessThan(150);
    } finally {
      await handle.shutdown().catch(() => {});
    }
  }, 10000);

  it('test 5: shutdown clears pending offline timer', async () => {
    const port = nextPort();
    const handle = await startWsServer(port, db, 10_485_760, filesDir, 5000);
    const { tokenA, tokenB } = setup();
    const wsB = await authConnect(port, tokenB, 'B');
    const onlineP = waitForMessage(wsB);
    const wsA = await authConnect(port, tokenA, 'A');
    await onlineP;

    wsA.close(); // arms a 5s offline timer
    const t0 = Date.now();
    await handle.shutdown(); // must resolve well under 5s
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10000);
});
