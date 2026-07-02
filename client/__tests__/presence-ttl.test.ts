import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient, Inbound, PresenceEntry } from '../src/index.ts';

let portCounter = 22500;
function nextPort() { return portCounter++; }
function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

describe('MeshClient presence (#43) + send ttl_ms (#44)', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let filesDir: string;
  const clients: MeshClient[] = [];
  let tokenA: string;
  let tokenB: string;

  function newClient(agentId: string, token: string): MeshClient {
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId, agentToken: token });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-presence-test-'));
    tokenA = generateToken();
    tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    aclGrant(db, 'A', 'B', 'system');
    aclGrant(db, 'B', 'A', 'system'); // ACL-related both ways → they see each other's presence
    handle = await startWsServer(port, db, 10_485_760, filesDir); // presenceDebounceMs=0 (immediate)
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  // ── #43: listPresence() ───────────────────────────────────────────────
  it('listPresence() returns the ACL-scoped roster incl. self, with online + lastSeen', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    await a.connect();
    await b.connect();
    await delay(100); // let B's online state settle

    const roster = await a.listPresence();
    const byId = Object.fromEntries(roster.map((e: PresenceEntry) => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(['A', 'B']);
    expect(byId.B.online).toBe(true);
    expect(typeof byId.B.lastSeen).toBe('number');
    expect(byId.A.online).toBe(true); // self
  });

  // ── #43: 'presence' event on a peer's status change ───────────────────
  it("emits a 'presence' event when an ACL-related peer comes online", async () => {
    const a = newClient('A', tokenA);
    await a.connect();

    const gotB = new Promise<PresenceEntry>((resolve) => {
      a.on('presence', (e: PresenceEntry) => { if (e.id === 'B') resolve(e); });
    });

    const b = newClient('B', tokenB);
    await b.connect();

    const ev = await gotB;
    expect(ev.id).toBe('B');
    expect(ev.online).toBe(true);
    expect(typeof ev.lastSeen).toBe('number');
  }, 10000);

  it("emits a 'presence' event (online:false) when a peer disconnects", async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    await a.connect();
    await b.connect();
    await delay(100);

    const gotOffline = new Promise<PresenceEntry>((resolve) => {
      a.on('presence', (e: PresenceEntry) => { if (e.id === 'B' && !e.online) resolve(e); });
    });
    b.close();
    const ev = await gotOffline;
    expect(ev.id).toBe('B');
    expect(ev.online).toBe(false);
  }, 10000);

  // ── #44: send(..., { ttlMs }) ─────────────────────────────────────────
  it('send with ttlMs:0 to an OFFLINE recipient is dropped (never delivered on reconnect)', async () => {
    const a = newClient('A', tokenA);
    await a.connect();

    // B is offline. ttl_ms:0 = "drop if recipient offline".
    await a.send('B', 'ephemeral', { ttlMs: 0 });

    const b = newClient('B', tokenB);
    const received: Inbound[] = [];
    b.onMessage((m) => received.push(m));
    await b.connect();
    await delay(300); // give any (non-)drain time to arrive

    expect(received.map((m) => m.text)).not.toContain('ephemeral');
  }, 10000);

  it('send with default ttl to an OFFLINE recipient is queued and delivered on reconnect', async () => {
    const a = newClient('A', tokenA);
    await a.connect();

    await a.send('B', 'durable'); // default ttl → queues while offline

    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();

    const msg = await got;
    expect(msg.text).toBe('durable');
    expect(msg.from).toBe('A');
  }, 10000);
});
