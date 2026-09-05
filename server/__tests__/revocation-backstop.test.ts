import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, setAgentDisabled } from '../db.ts';
import { startCleanup, DISABLED_SWEEP_INTERVAL_MS } from '../cleanup.ts';
import type { WebSocket } from 'ws';

// §5.4 revocation backstop.
//
// DELETE /registration-keys/:id commits the revocation, then closes each
// agent's socket best-effort OUTSIDE the transaction. A crash between those
// two, or a socket not reachable from that request's ctx, left a revoked agent
// holding a live authenticated connection forever: `disabled` is enforced at
// the auth frame, which an established socket has already passed.
//
// The fix makes the invariant STATE rather than an action, so these tests
// deliberately NEVER call the sweep — they mark an agent disabled and let the
// running cleanup do it. A test that called the sweep directly would stay green
// if the timer were removed from startCleanup, which is the exact shape of
// claude-spawner#320: a leg tested, never wired, green in production.

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface FakeSocket {
  sent: string[];
  closes: Array<{ code: number; reason: string }>;
}

function fakeSocket(): FakeSocket & WebSocket {
  const rec: FakeSocket = { sent: [], closes: [] };
  return {
    ...rec,
    send(data: string) { rec.sent.push(data); },
    close(code: number, reason: string) { rec.closes.push({ code, reason }); },
    get sentRef() { return rec.sent; },
  } as unknown as FakeSocket & WebSocket;
}

describe('§5.4 revocation backstop: disabled sockets are swept', () => {
  it('closes a disabled agent\'s live socket without anyone calling closeAgentSocket', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'revoked-one', token_hash: 'a'.repeat(64), hostname: 'h1' });
    const ws = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['revoked-one', ws]]);

    // Interval long enough that the ordinary cleanup tick never runs; only the
    // disabled sweep can close this socket.
    const handle = startCleanup(db, agentIndex, 3_600_000, null, 20);

    // The revocation half that "succeeded": the DB says disabled. The half that
    // failed: nothing closed the socket. This is the post-crash state.
    setAgentDisabled(db, 'revoked-one', true);

    await wait(120);
    handle.stop();

    expect(ws.closes.length).toBeGreaterThan(0);
    expect(ws.closes[0]!.code).toBe(1008);
    expect(ws.sent.some(m => JSON.parse(m).code === 'AUTH_FAILED')).toBe(true);

    db.close();
  });

  it('leaves an enabled agent\'s socket alone', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'live-one', token_hash: 'b'.repeat(64), hostname: 'h2' });
    const ws = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['live-one', ws]]);

    const handle = startCleanup(db, agentIndex, 3_600_000, null, 20);
    await wait(120);
    handle.stop();

    expect(ws.closes.length).toBe(0);
    expect(ws.sent.length).toBe(0);

    db.close();
  });

  it('stops sweeping after handle.stop() — no timer outlives the handle', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'late-revoked', token_hash: 'c'.repeat(64), hostname: 'h3' });
    const ws = fakeSocket();
    const agentIndex = new Map<string, WebSocket>([['late-revoked', ws]]);

    const handle = startCleanup(db, agentIndex, 3_600_000, null, 20);
    handle.stop();
    setAgentDisabled(db, 'late-revoked', true);

    await wait(120);

    expect(ws.closes.length).toBe(0);

    db.close();
  });

  // The bound is a promise to an operator ("a revoked agent cannot hold a
  // socket longer than this"), and it must not be reachable from the DB-churn
  // knob. Pinned as a value because the coupling — not the number — was the
  // defect: MESH_CLEANUP_INTERVAL_MS is accepted up to 3600000, so pacing
  // revocation with it would let a churn-tuning operator silently widen the
  // revocation-failure window to an hour.
  it('the sweep interval is a fixed constant, not the operator-tunable one', () => {
    expect(DISABLED_SWEEP_INTERVAL_MS).toBe(15_000);
    expect(process.env.MESH_CLEANUP_INTERVAL_MS).not.toBe(String(DISABLED_SWEEP_INTERVAL_MS));
  });
});
