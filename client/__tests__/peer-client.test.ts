import { describe, it, expect } from 'bun:test';
import { WebSocketServer, WebSocket } from 'ws';
import { MeshClient, PeerClient } from '../src/index.ts';

// F0c (§7) — PeerClient is a specialisation of MeshClient over three seams,
// not a parallel implementation. These tests exist to pin the seams AND to pin
// that opening them changed nothing for an ordinary agent.

// GUARD, learned the hard way: MeshClientConfig's key is `serverUrl`. Passing
// `url` is silently ignored and the client falls back to process.env
// MESH_SERVER_URL — so a typo'd test connects to the REAL mesh and fails with a
// confusing "unknown agent" from production. Cleared here so a future typo
// fails as "no server" rather than quietly leaving the test harness.
delete process.env.MESH_SERVER_URL;
delete process.env.MESH_AGENT_ID;
delete process.env.MESH_AGENT_TOKEN;

let portCounter = 21400;
const nextPort = () => portCounter++;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Harness {
  port: number;
  authFrames: Record<string, unknown>[];
  sockets: WebSocket[];
  close: () => Promise<void>;
  /** Send an error frame to the most recent socket. */
  sendError: (code: string, ref?: string) => void;
}

/** A stub mesh that records auth frames and can be told how to answer. */
function stubMesh(opts: { authOk?: boolean } = {}): Promise<Harness> {
  const port = nextPort();
  const authOk = opts.authOk ?? true;
  const authFrames: Record<string, unknown>[] = [];
  const sockets: WebSocket[] = [];
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame.type === 'auth') {
        authFrames.push(frame);
        if (authOk) {
          ws.send(JSON.stringify({ type: 'auth_ok', agent_id: frame.agent_id, queued: 0, queued_files: 0 }));
        } else {
          ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'nope' }));
        }
        return;
      }
      if (frame.type === 'relay') {
        ws.send(JSON.stringify({ type: 'ack', ref: frame.msg_id, ok: true }));
      }
    });
  });

  return new Promise((resolve) => {
    wss.on('listening', () => resolve({
      port,
      authFrames,
      sockets,
      // wss.close()'s callback does not fire while a socket lingers, and a
      // client that reconnected during the test leaves one — which HANGS
      // teardown instead of failing it. Verified directly: the reconnect
      // behaviour under test is correct while 'wss closed' never printed.
      // Sockets are terminated first and the wait is bounded, so a teardown
      // problem can never masquerade as a test failure.
      close: () => new Promise<void>((r) => {
        for (const ws of sockets) { try { ws.terminate(); } catch { /* ignore */ } }
        let done = false;
        const finish = () => { if (!done) { done = true; r(); } };
        wss.close(finish);
        setTimeout(finish, 300);
      }),
      sendError: (code, ref) => {
        const ws = sockets[sockets.length - 1];
        if (ws !== undefined) ws.send(JSON.stringify({ type: 'error', code, message: code, ...(ref ? { ref } : {}) }));
      },
    }));
  });
}

describe('F0c: the agent auth frame is UNCHANGED', () => {
  // The load-bearing test of this PR. authExtras() is merged into the auth
  // frame for every client, so a default that was not exactly {} would change
  // what every existing agent sends to every existing server.
  it('MeshClient sends exactly {type, agent_id, token} — no protocol field', async () => {
    const mesh = await stubMesh();
    const client = new MeshClient({ serverUrl: `ws://127.0.0.1:${mesh.port}`, agentId: 'A', agentToken: 'tok' });
    try {
      await client.connect();
      await wait(50);
      expect(mesh.authFrames.length).toBe(1);
      // Exact shape, not a subset check: an ADDED field is precisely the
      // regression, and a "has these keys" assertion cannot see one.
      expect(Object.keys(mesh.authFrames[0]!).sort()).toEqual(['agent_id', 'token', 'type']);
      expect(mesh.authFrames[0]).toEqual({ type: 'auth', agent_id: 'A', token: 'tok' });
    } finally {
      try { client.close(); } catch { /* ignore */ }
      await mesh.close();
    }
  }, 15_000);
});

describe('F0c: PeerClient', () => {
  it('announces protocol 1 on its auth frame', async () => {
    const mesh = await stubMesh();
    const peer = new PeerClient({ serverUrl: `ws://127.0.0.1:${mesh.port}`, agentId: 'ourmesh', agentToken: 'ptok' });
    try {
      await peer.connect();
      await wait(50);
      expect(mesh.authFrames[0]).toEqual({ type: 'auth', agent_id: 'ourmesh', token: 'ptok', protocol: 1 });
    } finally {
      try { peer.close(); } catch { /* ignore */ }
      await mesh.close();
    }
  }, 15_000);

  it('relay() resolves on the ack keyed by the REMOTE msg_id', async () => {
    const mesh = await stubMesh();
    const peer = new PeerClient({ serverUrl: `ws://127.0.0.1:${mesh.port}`, agentId: 'ourmesh', agentToken: 'ptok' });
    try {
      await peer.connect();
      await expect(peer.relay({
        type: 'relay', msg_id: 'remote-1', kind: 'direct',
        from: 'ourmesh:a', to: 'b', payload: 'hi',
      })).resolves.toBeUndefined();
    } finally {
      try { peer.close(); } catch { /* ignore */ }
      await mesh.close();
    }
  }, 15_000);

  it('stops for good on a POST-first-auth AUTH_FAILED, emitting the code', async () => {
    // For a peer this means the far side REVOKED the link — its admin made a
    // decision. Reconnecting would be retrying against a deliberately closed
    // door.
    const mesh = await stubMesh();
    const peer = new PeerClient({ serverUrl: `ws://127.0.0.1:${mesh.port}`, agentId: 'ourmesh', agentToken: 'ptok' });
    const errors: { code?: string }[] = [];
    peer.on('error', (e: unknown) => errors.push(e as { code?: string }));
    try {
      await peer.connect();
      await wait(50);
      const connectionsAfterFirst = mesh.authFrames.length;

      mesh.sendError('AUTH_FAILED');
      await wait(400);

      expect(errors.some(e => e.code === 'AUTH_FAILED')).toBe(true);
      // Did not come back: no further auth frame arrived.
      expect(mesh.authFrames.length).toBe(connectionsAfterFirst);
    } finally {
      try { peer.close(); } catch { /* ignore */ }
      await mesh.close();
    }
  }, 15_000);

  it('stops on PROTOCOL_MISMATCH at any time', async () => {
    const mesh = await stubMesh();
    const peer = new PeerClient({ serverUrl: `ws://127.0.0.1:${mesh.port}`, agentId: 'ourmesh', agentToken: 'ptok' });
    const errors: { code?: string }[] = [];
    peer.on('error', (e: unknown) => errors.push(e as { code?: string }));
    try {
      await peer.connect();
      await wait(50);
      const before = mesh.authFrames.length;
      mesh.sendError('PROTOCOL_MISMATCH');
      await wait(400);
      expect(errors.some(e => e.code === 'PROTOCOL_MISMATCH')).toBe(true);
      expect(mesh.authFrames.length).toBe(before);
    } finally {
      try { peer.close(); } catch { /* ignore */ }
      await mesh.close();
    }
  }, 15_000);
});

describe('F0c: MeshClient reconnection semantics are NOT changed', () => {
  // The counterpart to the peer test above, and the reason isFatalError is a
  // seam rather than a rewritten condition. An agent seeing AUTH_FAILED after a
  // successful first auth is usually looking at a restarted server; giving up
  // would be worse than retrying. This pins that today's behaviour survived
  // being made overridable.
  it('MeshClient still reconnects after a POST-first-auth AUTH_FAILED', async () => {
    const mesh = await stubMesh();
    const client = new MeshClient({ serverUrl: `ws://127.0.0.1:${mesh.port}`, agentId: 'A', agentToken: 'tok' });
    try {
      await client.connect();
      await wait(50);
      const before = mesh.authFrames.length;
      expect(before).toBe(1);

      mesh.sendError('AUTH_FAILED');
      // Close the socket too: the client reconnects on disconnect, and the
      // point is that the error did not set shouldReconnect = false.
      mesh.sockets[mesh.sockets.length - 1]?.close();
      await wait(1200);

      expect(mesh.authFrames.length).toBeGreaterThan(before);
    } finally {
      try { client.close(); } catch { /* ignore */ }
      await mesh.close();
    }
  }, 20_000);
});
