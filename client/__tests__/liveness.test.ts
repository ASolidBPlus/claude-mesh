import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { WebSocketServer } from 'ws';
import * as net from 'net';
import { MeshClient } from '../src/client.ts';

// Acceptance tests for the channel-drop class (design note §4).
//
// THE WEDGE — a real black hole, not a cooperative one. The client connects
// through a TCP proxy; `wedge()` stops forwarding in BOTH directions while
// keeping every socket open and undestroyed. Nothing is closed, nothing is
// reset, so the client's `ws` sees no close handshake and no transport error:
// readyState stays OPEN while packets go nowhere. That is precisely the
// half-open condition both incidents hit, and it needs no cooperation from the
// server (which is the point — a real severed path doesn't ask permission).
//
// ANTI-VACUITY: an earlier version of this harness "wedged" by reaching for
// `ws._socket`, which is undefined under Bun — so the wedge silently did
// nothing and the tests failed for an unrelated reason. Every wedge test now
// asserts the specific mechanism (a genuinely NEW socket authenticated / the
// exact rejection code), and the whole file was run against the PRE-FIX client
// to confirm each one fails for the right reason — see the PR body.

let portCounter = 27500;
const nextPort = () => portCounter++;

interface Harness {
  port: number; // the PROXY port the client dials
  /** How many times a client completed auth (i.e. how many sockets got authed). */
  authCount: () => number;
  /** Black-hole the connection: stop forwarding both ways, close nothing. */
  wedge: () => void;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const realPort = nextPort();
  const proxyPort = nextPort();
  const wss = new WebSocketServer({ port: realPort });
  let auths = 0;

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let f: Record<string, unknown>;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.type === 'auth') {
        auths++;
        ws.send(JSON.stringify({ type: 'auth_ok', agent_id: f.agent_id, queued: 0, queued_files: 0 }));
        return;
      }
      if (f.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: f.ts, server_ts: Date.now() }));
        return;
      }
      // NOTE: deliberately never acks 'send' — lets us test the ack timeout.
    });
  });

  const pairs: { downstream: net.Socket; upstream: net.Socket }[] = [];
  let wedged = false;

  const proxy = net.createServer((downstream) => {
    const upstream = net.connect(realPort, '127.0.0.1');
    pairs.push({ downstream, upstream });
    if (!wedged) {
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    }
    downstream.on('error', () => {});
    upstream.on('error', () => {});
  });

  await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', () => resolve()));

  return {
    port: proxyPort,
    authCount: () => auths,
    wedge: () => {
      wedged = true;
      for (const { downstream, upstream } of pairs) {
        // Stop the flow WITHOUT closing: unpipe both directions and pause the
        // readers, so bytes written by either side simply never arrive. No FIN,
        // no RST, no close frame — the sockets stay up and oblivious.
        downstream.unpipe(upstream);
        upstream.unpipe(downstream);
        downstream.pause();
        upstream.pause();
      }
      // Let subsequent reconnects through, so recovery is observable.
      wedged = false;
    },
    close: async () => {
      for (const { downstream, upstream } of pairs) {
        try { downstream.destroy(); } catch { /* ignore */ }
        try { upstream.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 300);
        proxy.close(() => { clearTimeout(t); resolve(); });
      });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 300);
        wss.close(() => { clearTimeout(t); resolve(); });
      });
    },
  };
}

function makeClient(port: number): MeshClient {
  return new MeshClient({
    serverUrl: `ws://127.0.0.1:${port}`,
    agentId: 'liveness-agent',
    agentToken: 'tok',
    // Drive the liveness path in ms, not minutes. Production defaults (25s/60s/
    // 10s) are exercised by the constants themselves; the MECHANISM is what
    // these tests verify.
    pingIntervalMs: 60,
    pongDeadlineMs: 300,
    ackTimeoutMs: 400,
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `pred()` is true or the budget expires. Returns whether it held. */
async function until(pred: () => boolean, budgetMs: number, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(stepMs);
  }
  return pred();
}

describe('channel-drop: liveness + reconnect', () => {
  let h: Harness;
  let client: MeshClient | null = null;

  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => {
    client?.close();
    client = null;
    await h.close();
  });

  it('1. WEDGE (load-bearing): a severed socket is detected and the client reconnects', async () => {
    client = makeClient(h.port);
    await client.connect();
    expect(h.authCount()).toBe(1);

    let disconnects = 0;
    client.on('disconnect', () => { disconnects++; });

    // Sever the path with no close frame. Pre-fix, the client notices NOTHING:
    // readyState stays OPEN forever and no reconnect is ever scheduled.
    h.wedge();

    // ASSERT THE MECHANISM, not a proxy: a genuinely NEW socket must be
    // established AND authenticated. authCount rising to 2 can only happen via
    // detect → close → scheduleReconnect → openSocket → auth.
    const recovered = await until(() => h.authCount() >= 2, 8000);
    expect(recovered).toBe(true);
    expect(disconnects).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('2. a send into a wedged socket REJECTS with ACK_TIMEOUT (never hangs, never resolves)', async () => {
    client = makeClient(h.port);
    await client.connect();
    h.wedge();

    // Pre-fix this promise never settles at all — the waiter had no timeout.
    let code: string | undefined;
    let resolved = false;
    try {
      await client.send('peer', 'into the void');
      resolved = true;
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(resolved).toBe(false);
    // Either the ack timeout fires, or liveness detects the drop first and fails
    // it as a reset — both are correct "surfaced as an error", never silence.
    expect(['ACK_TIMEOUT', 'CONNECTION_RESET']).toContain(code!);
  }, 20000);

  it('3. a stale liveness timer never terminates the NEW socket after a reconnect', async () => {
    client = makeClient(h.port);
    await client.connect();

    h.wedge();
    const recovered = await until(() => h.authCount() >= 2, 8000);
    expect(recovered).toBe(true);

    const authsAfterRecovery = h.authCount();
    // The replacement socket is healthy and answering pings. If a timer left
    // over from the dead socket were still armed against it, it would terminate
    // it and force yet another reconnect. Assert the socket SURVIVES.
    await wait(1500);
    expect(h.authCount()).toBe(authsAfterRecovery);
  }, 25000);

  it('4. repeated wedge/reconnect cycles leave no timer accumulation, and close() is clean', async () => {
    client = makeClient(h.port);
    await client.connect();

    for (let i = 0; i < 3; i++) {
      const before = h.authCount();
      h.wedge();
      const ok = await until(() => h.authCount() > before, 8000);
      expect(ok).toBe(true);
    }
    expect(h.authCount()).toBe(4); // 1 initial + 3 recoveries, no extra churn

    const settled = h.authCount();
    client.close();
    client = null;
    // After close() nothing may reconnect: shouldReconnect is false and every
    // timer must be cleared (a surviving interval would re-open a socket).
    await wait(1200);
    expect(h.authCount()).toBe(settled);
  }, 30000);

  it('5. NO REGRESSION: a healthy socket answering pings is never terminated', async () => {
    client = makeClient(h.port);
    await client.connect();
    expect(h.authCount()).toBe(1);

    let disconnects = 0;
    client.on('disconnect', () => { disconnects++; });

    // Sit idle well past the liveness check interval. Pongs keep rolling the
    // deadline, so the dead-man must never fire.
    await wait(2000);
    expect(h.authCount()).toBe(1);
    expect(disconnects).toBe(0);
  }, 20000);
});
