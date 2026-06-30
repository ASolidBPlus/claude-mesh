import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, getAgentById, insertMessage, insertFile, aclGrant } from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import * as crypto from 'crypto';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

  // ──────────────────────────────────────────────
  // Sprint 4: Auth success flow
  // ──────────────────────────────────────────────

  it('valid auth frame receives auth_ok and connection stays open', async () => {
    const rawToken = generateToken();
    const hash = hashToken(rawToken);
    registerAgent(db, { id: 'agent-auth-ok', token_hash: hash, hostname: 'host1' });

    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);

    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-auth-ok', token: rawToken }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('auth_ok');
    expect(msg.agent_id).toBe('agent-auth-ok');
    expect(msg.queued).toBe(0);

    // Connection should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);

  it('auth frame with unknown agent_id receives AUTH_FAILED and connection closes with 1008', async () => {
    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    ws.send(JSON.stringify({ type: 'auth', agent_id: 'no-such-agent', token: 'deadbeef' }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('AUTH_FAILED');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  }, 10000);

  it('auth frame with wrong token receives AUTH_FAILED and connection closes with 1008', async () => {
    const rawToken = generateToken();
    const hash = hashToken(rawToken);
    registerAgent(db, { id: 'agent-wrong-tok', token_hash: hash, hostname: 'host1' });

    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    const closePromise = waitForClose(ws);

    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-wrong-tok', token: 'wrongtoken' }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('AUTH_FAILED');

    const close = await closePromise;
    expect(close.code).toBe(1008);
  }, 10000);

  it('after successful auth, agent is online=1 in DB', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-online', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-online', token: rawToken }));
    await msgPromise;

    const agent = getAgentById(db, 'agent-online');
    expect(agent!.online).toBe(1);
    ws.close();
  }, 10000);

  it('after authed client disconnects, agent is online=0 in DB', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-offline', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-offline', token: rawToken }));
    await msgPromise;

    const closePromise = waitForClose(ws);
    ws.close();
    await closePromise;

    // Give server a moment to process the close event
    await new Promise(r => setTimeout(r, 50));

    const agent = getAgentById(db, 'agent-offline');
    expect(agent!.online).toBe(0);
  }, 10000);

  it('queued count in auth_ok reflects pending messages', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-queued', token_hash: hashToken(rawToken), hostname: 'host1' });

    // Insert two pending direct messages
    insertMessage(db, {
      id: 'msg-1',
      kind: 'direct',
      from_agent: 'agent-queued',
      to_agent: 'agent-queued',
      payload: 'hello',
      sent_at: Date.now(),
      expires_at: null,
    });
    insertMessage(db, {
      id: 'msg-2',
      kind: 'direct',
      from_agent: 'agent-queued',
      to_agent: 'agent-queued',
      payload: 'world',
      sent_at: Date.now(),
      expires_at: null,
    });

    const ws = await connectWs(port);
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-queued', token: rawToken }));

    const msg = JSON.parse(await msgPromise);
    expect(msg.type).toBe('auth_ok');
    expect(msg.queued).toBe(2);
    ws.close();
  }, 10000);

  // ──────────────────────────────────────────────
  // Sprint 4: Ping/pong
  // ──────────────────────────────────────────────

  it('authenticated client sending ping receives pong with matching ts and positive server_ts', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-ping', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);

    // Auth first
    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-ping', token: rawToken }));
    await authMsgPromise;

    // Send ping
    const pongPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'ping', ts: 12345 }));

    const pong = JSON.parse(await pongPromise);
    expect(pong.type).toBe('pong');
    expect(pong.ts).toBe(12345);
    expect(typeof pong.server_ts).toBe('number');
    expect(pong.server_ts).toBeGreaterThan(0);
    ws.close();
  }, 10000);

  it('after ping, last_seen in DB is >= value after auth_ok', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-ping-ls', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);

    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-ping-ls', token: rawToken }));
    await authMsgPromise;

    const lastSeenAfterAuth = getAgentById(db, 'agent-ping-ls')!.last_seen;

    const pongPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    await pongPromise;

    const lastSeenAfterPing = getAgentById(db, 'agent-ping-ls')!.last_seen;
    expect(lastSeenAfterPing).toBeGreaterThanOrEqual(lastSeenAfterAuth);
    ws.close();
  }, 10000);

  // ──────────────────────────────────────────────
  // Sprint 4: agent_status broadcast
  // ──────────────────────────────────────────────

  it('when agent A connects, agent B receives agent_status online=true for A', async () => {
    const tokenA = generateToken();
    const tokenB = generateToken();
    registerAgent(db, { id: 'agent-A-status', token_hash: hashToken(tokenA), hostname: 'hostA' });
    registerAgent(db, { id: 'agent-B-status', token_hash: hashToken(tokenB), hostname: 'hostB' });
    aclGrant(db, 'agent-A-status', 'agent-B-status', 'system');

    // Connect B first and auth
    const wsB = await connectWs(port);
    const authBPromise = waitForMessage(wsB);
    wsB.send(JSON.stringify({ type: 'auth', agent_id: 'agent-B-status', token: tokenB }));
    await authBPromise;

    // Now connect A — B should receive agent_status
    const statusForB = waitForMessage(wsB);
    const wsA = await connectWs(port);
    const authAPromise = waitForMessage(wsA);
    wsA.send(JSON.stringify({ type: 'auth', agent_id: 'agent-A-status', token: tokenA }));
    await authAPromise;

    const statusMsg = JSON.parse(await statusForB);
    expect(statusMsg.type).toBe('agent_status');
    expect(statusMsg.agent_id).toBe('agent-A-status');
    expect(statusMsg.online).toBe(true);
    expect(typeof statusMsg.last_seen).toBe('number');

    wsA.close();
    wsB.close();
  }, 10000);

  it('when agent A disconnects, agent B receives agent_status online=false for A', async () => {
    const tokenA = generateToken();
    const tokenB = generateToken();
    registerAgent(db, { id: 'agent-A-disc', token_hash: hashToken(tokenA), hostname: 'hostA' });
    registerAgent(db, { id: 'agent-B-disc', token_hash: hashToken(tokenB), hostname: 'hostB' });
    aclGrant(db, 'agent-A-disc', 'agent-B-disc', 'system');

    // Connect and auth both
    const wsB = await connectWs(port);
    const authBPromise = waitForMessage(wsB);
    wsB.send(JSON.stringify({ type: 'auth', agent_id: 'agent-B-disc', token: tokenB }));
    await authBPromise;

    const wsA = await connectWs(port);
    // B gets the online notification for A — consume it
    const onlineNotifPromise = waitForMessage(wsB);
    const authAPromise = waitForMessage(wsA);
    wsA.send(JSON.stringify({ type: 'auth', agent_id: 'agent-A-disc', token: tokenA }));
    await authAPromise;
    await onlineNotifPromise;

    // Now disconnect A — B should get offline notification
    const offlineNotifPromise = waitForMessage(wsB);
    wsA.close();

    const offlineMsg = JSON.parse(await offlineNotifPromise);
    expect(offlineMsg.type).toBe('agent_status');
    expect(offlineMsg.agent_id).toBe('agent-A-disc');
    expect(offlineMsg.online).toBe(false);
    expect(typeof offlineMsg.last_seen).toBe('number');

    wsB.close();
  }, 10000);

  it('agent A does NOT receive its own agent_status notification when it connects', async () => {
    const tokenA = generateToken();
    registerAgent(db, { id: 'agent-A-noself', token_hash: hashToken(tokenA), hostname: 'hostA' });

    const wsA = await connectWs(port);
    const authAPromise = waitForMessage(wsA);
    wsA.send(JSON.stringify({ type: 'auth', agent_id: 'agent-A-noself', token: tokenA }));

    const authMsg = JSON.parse(await authAPromise);
    // Should be auth_ok, not agent_status
    expect(authMsg.type).toBe('auth_ok');

    // Give a moment to ensure no extra message arrives
    const extraMsg = await Promise.race([
      waitForMessage(wsA),
      new Promise<null>(r => setTimeout(() => r(null), 200)),
    ]);
    expect(extraMsg).toBeNull();

    wsA.close();
  }, 10000);

  // ──────────────────────────────────────────────
  // Sprint 4: Post-auth non-ping frames
  // ──────────────────────────────────────────────

  it('authenticated client sending unknown frame type receives NOT_IMPLEMENTED and connection stays open', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-ni', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-ni', token: rawToken }));
    await authMsgPromise;

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'unknown_frame_type_xyz' }));

    const reply = JSON.parse(await replyPromise);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('NOT_IMPLEMENTED');

    // Connection should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);

  // Characterization for #17: a post-auth frame whose `type` is non-string or
  // absent must fall through to NOT_IMPLEMENTED (connection stays open) — the
  // same path as an unknown string type. Pins the dispatch-map `typeof
  // frameType === 'string'` guard before the if-chain → table extraction.
  it('authenticated client sending a non-string frame type receives NOT_IMPLEMENTED and stays open', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-ni-num', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-ni-num', token: rawToken }));
    await authMsgPromise;

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 123 }));

    const reply = JSON.parse(await replyPromise);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('NOT_IMPLEMENTED');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);

  it('authenticated client sending a frame with no type receives NOT_IMPLEMENTED and stays open', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-ni-none', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-ni-none', token: rawToken }));
    await authMsgPromise;

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ foo: 'bar' }));

    const reply = JSON.parse(await replyPromise);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('NOT_IMPLEMENTED');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);

  it('authenticated client sending send frame with unknown recipient receives error', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'agent-send-err', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'agent-send-err', token: rawToken }));
    await authMsgPromise;

    const replyPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'send', msg_id: 'test-msg-id', to: 'unknown-recipient', payload: 'hello' }));

    const reply = JSON.parse(await replyPromise);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('AGENT_NOT_FOUND');
    expect(reply.ref).toBe('test-msg-id');

    // Connection should still be open
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);

  // ──────────────────────────────────────────────
  // Sprint 9: file_send frame dispatch
  // ──────────────────────────────────────────────

  it('file_send frame is dispatched to routeFile and acked on success', async () => {
    const tokenA = generateToken();
    const tokenB = generateToken();
    registerAgent(db, { id: 'ws-file-sender', token_hash: hashToken(tokenA), hostname: 'host1' });
    registerAgent(db, { id: 'ws-file-recv', token_hash: hashToken(tokenB), hostname: 'host2' });

    // Grant ACL
    const { aclGrant } = await import('../db.ts');
    aclGrant(db, 'ws-file-sender', 'ws-file-recv', 'system');

    const wsA = await connectWs(port);
    const authMsgA = waitForMessage(wsA);
    wsA.send(JSON.stringify({ type: 'auth', agent_id: 'ws-file-sender', token: tokenA }));
    await authMsgA;

    const wsB = await connectWs(port);
    const authMsgB = waitForMessage(wsB);
    wsB.send(JSON.stringify({ type: 'auth', agent_id: 'ws-file-recv', token: tokenB }));
    await authMsgB;

    const data = Buffer.from('file content for ws test').toString('base64');
    const msgId = crypto.randomUUID();

    // wsB will receive file_deliver; wsA will receive ack
    const bPromise = waitForMessage(wsB);
    const aPromise = waitForMessage(wsA);

    wsA.send(JSON.stringify({
      type: 'file_send',
      msg_id: msgId,
      to: 'ws-file-recv',
      filename: 'ws-test.txt',
      content_type: 'text/plain',
      data,
    }));

    const ack = JSON.parse(await aPromise);
    expect(ack.type).toBe('ack');
    expect(ack.ref).toBe(msgId);
    expect(ack.ok).toBe(true);

    const deliver = JSON.parse(await bPromise);
    expect(deliver.type).toBe('file_deliver');
    expect(deliver.filename).toBe('ws-test.txt');
    expect(deliver.from).toBe('ws-file-sender');

    wsA.close();
    wsB.close();
  }, 10000);

  it('file_send with AGENT_NOT_FOUND returns error', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'ws-file-err-sender', token_hash: hashToken(rawToken), hostname: 'host1' });

    const ws = await connectWs(port);
    const authMsg = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'ws-file-err-sender', token: rawToken }));
    await authMsg;

    const replyPromise = waitForMessage(ws);
    const data = Buffer.from('x').toString('base64');
    ws.send(JSON.stringify({
      type: 'file_send',
      msg_id: 'err-msg-id',
      to: 'ghost-agent',
      filename: 'x.txt',
      data,
    }));

    const reply = JSON.parse(await replyPromise);
    expect(reply.type).toBe('error');
    expect(reply.code).toBe('AGENT_NOT_FOUND');
    expect(reply.ref).toBe('err-msg-id');
    ws.close();
  }, 10000);

  it('auth_ok includes queued_files count', async () => {
    const rawToken = generateToken();
    registerAgent(db, { id: 'ws-qf-agent', token_hash: hashToken(rawToken), hostname: 'host1' });

    // Insert a queued file for this agent (offline delivery scenario)
    const filePath = join(filesDir, 'queued-file-id');
    require('fs').writeFileSync(filePath, 'queued file');
    insertFile(db, {
      id: 'queued-file-id',
      from_agent: 'some-sender',
      to_agent: 'ws-qf-agent',
      filename: 'queued.txt',
      content_type: 'text/plain',
      size_bytes: 11,
      file_path: filePath,
      sent_at: Date.now(),
      expires_at: Date.now() + 300_000,
    });

    const ws = await connectWs(port);
    const authMsgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'auth', agent_id: 'ws-qf-agent', token: rawToken }));
    const authMsgRaw = await authMsgPromise;
    const authMsg = JSON.parse(authMsgRaw);

    expect(authMsg.type).toBe('auth_ok');
    expect(authMsg.queued_files).toBe(1);

    ws.close();
  }, 10000);
});
