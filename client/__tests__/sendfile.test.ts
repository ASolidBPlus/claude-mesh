import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient, Inbound } from '../src/index.ts';

let portCounter = 23500;
function nextPort() { return portCounter++; }

describe('MeshClient sendFile + file_deliver metadata (#55 F1 / #56 F2a)', () => {
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
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-sendfile-test-'));
    tokenA = generateToken();
    tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    aclGrant(db, 'A', 'B', 'system'); // A may send to B
    handle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('delivers a file inbound to an online recipient with all metadata preserved', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();
    await a.connect();

    const data = new TextEncoder().encode('hello, file world');
    await a.sendFile('B', {
      data, filename: 'greeting.txt', contentType: 'text/plain',
      caption: 'a caption', replyToMsgId: 'm-1',
    });

    const msg = await got;
    expect(msg.kind).toBe('file');
    expect(msg.from).toBe('A');
    expect(msg.filename).toBe('greeting.txt');
    expect(msg.contentType).toBe('text/plain');
    expect(msg.size).toBe(data.byteLength);
    expect(msg.caption).toBe('a caption');
    expect(msg.replyToMsgId).toBe('m-1');
    // fetch_url is preserved and is the relative /files/<id> path
    expect(typeof msg.fetchUrl).toBe('string');
    expect(msg.fetchUrl).toBe(`/files/${msg.fileId}`);
    // file inbounds carry no inline payload
    expect(msg.text).toBeNull();
    expect(msg.payload).toBeNull();
  }, 10000);

  it('queues for an offline recipient and delivers on reconnect; contentType defaults', async () => {
    const a = newClient('A', tokenA);
    await a.connect();

    const data = new TextEncoder().encode('queued bytes');
    await a.sendFile('B', { data, filename: 'q.bin' }); // no contentType

    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();

    const msg = await got;
    expect(msg.kind).toBe('file');
    expect(msg.filename).toBe('q.bin');
    expect(msg.contentType).toBe('application/octet-stream'); // server default
    expect(msg.size).toBe(data.byteLength);
    expect(msg.caption).toBeNull();
  }, 10000);

  it('accepts an ArrayBuffer as data', async () => {
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);
    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await b.connect();
    await a.connect();

    const bytes = new TextEncoder().encode('arraybuffer path');
    await a.sendFile('B', { data: bytes.buffer, filename: 'ab.bin' });

    const msg = await got;
    expect(msg.kind).toBe('file');
    expect(msg.size).toBe(bytes.byteLength);
  }, 10000);
});
