import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb } from '../db.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import * as crypto from 'crypto';

// Use a port range that won't conflict
let portCounter = 19100;
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

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('startWsServer', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    handle = await startWsServer(port, db);
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('resolves and wss is listening on the given port', async () => {
    expect(handle.wss).toBeDefined();
    expect(handle.wss.address()).toBeTruthy();
    const addr = handle.wss.address() as { port: number };
    expect(addr.port).toBe(port);
  });

  it('sends AUTH_TIMEOUT error and closes when no frame is sent within 5 seconds', async () => {
    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('AUTH_TIMEOUT');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  }, 10000);

  it('sends AUTH_REQUIRED and closes with 1008 when first frame type is not auth', async () => {
    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    ws.send(JSON.stringify({ type: 'ping' }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('AUTH_REQUIRED');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  });

  it('sends AUTH_REQUIRED and closes with 1008 when first frame is non-JSON', async () => {
    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    ws.send('this is not json');

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('AUTH_REQUIRED');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  });

  it('sends NOT_IMPLEMENTED and closes with 1011 when auth frame is sent', async () => {
    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    ws.send(JSON.stringify({ type: 'auth', agent_id: 'x', token: 'y' }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('NOT_IMPLEMENTED');

    const close = await closePromise;
    expect(close.code).toBe(1011);
  });

  it('sends close code 1001 to idle connected client on shutdown', async () => {
    // Use a raw TCP socket to capture the actual close frame bytes
    const closeCode = await new Promise<number>((resolve) => {
      const sock = net.createConnection(port, '127.0.0.1');
      const wsKey = crypto.randomBytes(16).toString('base64');

      sock.write([
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n'));

      let upgraded = false;
      let buffer = Buffer.alloc(0);

      sock.on('data', async (data) => {
        if (!upgraded) {
          if (data.toString().includes('\r\n\r\n')) {
            upgraded = true;
            // Trigger shutdown now that we're connected
            await handle.shutdown();
          }
          return;
        }

        buffer = Buffer.concat([buffer, data]);
        // Look for close frame: opcode 0x08
        for (let i = 0; i < buffer.length - 1; i++) {
          const byte0 = buffer[i];
          if ((byte0 & 0x0f) === 0x08) {
            const byte1 = buffer[i + 1];
            const len = byte1 & 0x7f;
            if (len >= 2 && buffer.length >= i + 2 + len) {
              const code = (buffer[i + 2] << 8) | buffer[i + 3];
              sock.destroy();
              resolve(code);
              return;
            }
          }
        }
      });

      sock.on('error', () => resolve(0));
    });

    expect(closeCode).toBe(1001);
  });

  it('refuses new connections after shutdown', async () => {
    await handle.shutdown();

    // Use a raw TCP connection to check if the port is closed
    const connectionRefused = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(true));
    });

    expect(connectionRefused).toBe(true);
  });

  it('calling shutdown twice does not throw', async () => {
    await handle.shutdown();
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});
