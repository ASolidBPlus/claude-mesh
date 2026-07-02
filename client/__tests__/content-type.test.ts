import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient, Inbound } from '../src/index.ts';

let portCounter = 26500;
function nextPort() { return portCounter++; }
function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// 0.6.0: SendOpts.contentType + PublishOpts { contentType, ttlMs }.
describe('send/publish contentType + publish ttlMs (SDK 0.6.0)', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let filesDir: string;
  const clients: MeshClient[] = [];
  let tokenA: string, tokenB: string;

  function newClient(id: string, token: string): MeshClient {
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: id, agentToken: token });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-ct-test-'));
    tokenA = generateToken(); tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    aclGrant(db, 'A', 'B', 'system');
    handle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('send opts.contentType is delivered as Inbound.contentType', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((r) => b.onMessage(r));
    await b.connect();
    await a.connect();
    await a.send('B', '{"x":1}', { contentType: 'application/json' });
    const msg = await got;
    expect(msg.contentType).toBe('application/json');
    expect(msg.text).toBe('{"x":1}');
  }, 10000);

  it('publish opts.contentType is delivered on the topic copy', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((r) => b.onMessage(r));
    await b.connect();
    await b.subscribe('news');
    await a.connect();
    await a.publish('news', '# hi', { contentType: 'text/markdown' });
    const msg = await got;
    expect(msg.kind).toBe('topic');
    expect(msg.contentType).toBe('text/markdown');
  }, 10000);

  it('publish opts.ttlMs:0 drops for an offline subscriber (never delivered on reconnect)', async () => {
    const b = newClient('B', tokenB);
    await b.connect();
    await b.subscribe('t');
    b.close();
    await delay(100);

    const a = newClient('A', tokenA);
    await a.connect();
    await a.publish('t', 'ephemeral', { ttlMs: 0 }); // B subscribed but offline → dropped

    const b2 = newClient('B', tokenB);
    const received: Inbound[] = [];
    b2.onMessage((m) => received.push(m));
    await b2.connect();
    await delay(300);
    expect(received.map((m) => m.text)).not.toContain('ephemeral');
  }, 10000);
});
