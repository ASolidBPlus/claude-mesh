import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, aclGrant, getMessage } from '../db.ts';
import { hashToken } from '../auth.ts';
import { renderMetrics } from '../metrics.ts';
import { startWsServer, WsServerHandle, POST_AUTH_HANDLERS } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #94 — a duplicate msg_id from ANY authenticated client killed the server.
//
// frame.msg_id becomes messages.id (PRIMARY KEY), the post-auth dispatcher
// called handlers with no try/catch, and nothing in server/ installs an
// uncaughtException handler. So `UNIQUE constraint failed: messages.id` escaped
// to the process and the mesh died — every channel flapping until a restart.
// An honest SDK retry after a lost ack is enough to trigger it.
//
// Two halves, tested separately because they fail independently:
//   (1) the dispatcher guard — the CLASS fix: any handler throw becomes one
//       logged error frame to that socket, process untouched;
//   (2) a DUPLICATE_MSG_ID refusal — the specific case gets a meaningful answer
//       instead of an INTERNAL error.
//
// Everything here drives the REAL socket path. The bug was in the dispatcher,
// so a test that called a handler directly would be testing around it.

let portCounter = 20950;
function nextPort() { return portCounter++; }
function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Read the sender's accepted-and-routed counter out of the metrics render. */
function sentCountFor(db: Database, agentId: string): number {
  const line = renderMetrics(db)
    .split('\n')
    .find(l => l.startsWith(`mesh_messages_sent_total{from_agent="${agentId}"}`));
  return line === undefined ? 0 : Number(line.split(' ').pop());
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

interface Session { ws: WebSocket; frames: any[]; }

async function authConnect(port: number, id: string, token: string): Promise<Session> {
  const ws = await connect(port);
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: 'auth', agent_id: id, token }));
  await wait(80);
  return { ws, frames };
}

async function setup(): Promise<{ db: Database; handle: WsServerHandle; port: number }> {
  const db = openDb(':memory:');
  const port = nextPort();
  const handle = await startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-94-')));
  registerAgent(db, { id: 'A', token_hash: hashToken('ta'), hostname: 'h' });
  registerAgent(db, { id: 'B', token_hash: hashToken('tb'), hostname: 'h' });
  aclGrant(db, 'A', 'B', 'system');
  return { db, handle, port };
}

describe('#94: a duplicate msg_id is refused, not fatal', () => {
  it('the second send is refused and the FIRST message is unaffected', async () => {
    const { db, handle, port } = await setup();
    const a = await authConnect(port, 'A', 'ta');
    try {
      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'first', msg_id: 'dup-1' }));
      await wait(120);
      expect(a.frames.some(f => f.type === 'ack' && f.ref === 'dup-1' && f.ok === true)).toBe(true);

      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'second', msg_id: 'dup-1' }));
      await wait(150);

      const err = a.frames.find(f => f.type === 'error' && f.ref === 'dup-1');
      expect(err?.code).toBe('DUPLICATE_MSG_ID');
      // Not INTERNAL: the client is told what it did, not merely that something
      // broke. An honest retry deserves a diagnosable answer.
      expect(err?.code).not.toBe('INTERNAL');

      // The stored message is the FIRST one. A refusal that overwrote history
      // would be a worse bug than the crash — silent instead of loud.
      expect(getMessage(db, 'dup-1')?.payload).toBe('first');
    } finally {
      try { a.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('the socket and the server both survive, and still work afterwards', async () => {
    // The crash's real cost was availability: one client's bad frame stopped
    // the bus for everyone. So the assertion is that traffic still flows —
    // from the offending socket AND from an unrelated one.
    const { db, handle, port } = await setup();
    const a = await authConnect(port, 'A', 'ta');
    const b = await authConnect(port, 'B', 'tb');
    try {
      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'x', msg_id: 'dup-2' }));
      await wait(120);
      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'x', msg_id: 'dup-2' }));
      await wait(150);

      // Same socket still usable with a fresh id.
      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'after', msg_id: 'fresh-1' }));
      await wait(150);
      expect(a.frames.some(f => f.type === 'ack' && f.ref === 'fresh-1' && f.ok === true)).toBe(true);

      // And the bystander's connection was never disturbed.
      expect(b.frames.some(f => f.type === 'deliver' && f.payload === 'after')).toBe(true);
      expect(b.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      try { a.ws.close(); b.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('an ephemeral (ttl_ms=0) send stays repeatable — it persists no id to collide', async () => {
    // ttl_ms=0 stores nothing, so there is no primary key to violate and no
    // ambiguity to refuse. Pinned because a duplicate-id check written against
    // the frame rather than the stored row would silently break every
    // heartbeat-class stream that reuses ids.
    const { db, handle, port } = await setup();
    const a = await authConnect(port, 'A', 'ta');
    await authConnect(port, 'B', 'tb');
    try {
      for (let i = 0; i < 3; i++) {
        a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'beat', msg_id: 'beat-1', ttl_ms: 0 }));
        await wait(100);
      }
      const acks = a.frames.filter(f => f.type === 'ack' && f.ref === 'beat-1' && f.ok === true);
      expect(acks.length).toBe(3);
      expect(a.frames.some(f => f.type === 'error' && f.code === 'DUPLICATE_MSG_ID')).toBe(false);
    } finally {
      try { a.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});

describe('#94: the dispatcher guard is the class fix', () => {
  it('a throwing handler yields ONE error frame and leaves the process alive', async () => {
    // The duplicate msg_id was one reachable instance. The defect is that ANY
    // handler throw reached a process with no uncaughtException handler, so the
    // guard is proven against an arbitrary throw rather than against the one
    // bug that revealed it.
    const { db, handle, port } = await setup();
    const a = await authConnect(port, 'A', 'ta');
    POST_AUTH_HANDLERS['__test_throw'] = () => { throw new Error('deliberate handler explosion'); };
    try {
      const before = a.frames.length;
      a.ws.send(JSON.stringify({ type: '__test_throw', msg_id: 'boom-1' }));
      await wait(150);

      const emitted = a.frames.slice(before);
      const errs = emitted.filter(f => f.type === 'error');
      expect(errs.length).toBe(1);
      expect(errs[0].code).toBe('INTERNAL');
      expect(errs[0].ref).toBe('boom-1');
      // The throw did not close the socket, and the server still answers.
      expect(a.ws.readyState).toBe(WebSocket.OPEN);

      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'still here', msg_id: 'after-boom' }));
      await wait(150);
      expect(a.frames.some(f => f.type === 'ack' && f.ref === 'after-boom' && f.ok === true)).toBe(true);
    } finally {
      delete POST_AUTH_HANDLERS['__test_throw'];
      try { a.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  // THE property test. Every handler is synchronous today, so the sync case
  // above passes with a plain try/catch — and would keep passing while the
  // guard silently covered nothing the day a handler gained an `async`
  // keyword. The ws 'message' listener does not await, so a rejection becomes
  // an unhandled rejection and kills the process, with no line of the guard
  // changing. Federation F1 adds awaitable work to the relay path, so this is
  // a scheduled event, not a hypothetical. The HTTP plane already paid for it
  // once (#68).
  it('a handler returning a REJECTED PROMISE is caught identically', async () => {
    const { db, handle, port } = await setup();
    const a = await authConnect(port, 'A', 'ta');
    POST_AUTH_HANDLERS['__test_reject'] = () => Promise.reject(new Error('deliberate async explosion'));
    try {
      const before = a.frames.length;
      a.ws.send(JSON.stringify({ type: '__test_reject', msg_id: 'boom-2' }));
      await wait(200);

      const errs = a.frames.slice(before).filter(f => f.type === 'error');
      expect(errs.length).toBe(1);
      expect(errs[0].code).toBe('INTERNAL');
      expect(errs[0].ref).toBe('boom-2');
      expect(a.ws.readyState).toBe(WebSocket.OPEN);

      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'alive', msg_id: 'after-reject' }));
      await wait(150);
      expect(a.frames.some(f => f.type === 'ack' && f.ref === 'after-reject' && f.ok === true)).toBe(true);
    } finally {
      delete POST_AUTH_HANDLERS['__test_reject'];
      try { a.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('an async handler that RESOLVES is undisturbed — the guard is not a filter', () => {
    // Positive control: the thenable branch must pass success through
    // untouched, or "no error frame" above would be satisfied by a guard that
    // swallows everything.
    return (async () => {
      const { db, handle, port } = await setup();
      const a = await authConnect(port, 'A', 'ta');
      let ran = false;
      POST_AUTH_HANDLERS['__test_ok'] = async (ctx) => {
        ran = true;
        ctx.ws.send(JSON.stringify({ type: 'ack', ref: 'ok-1', ok: true }));
      };
      try {
        a.ws.send(JSON.stringify({ type: '__test_ok', msg_id: 'ok-1' }));
        await wait(200);
        expect(ran).toBe(true);
        expect(a.frames.some(f => f.type === 'ack' && f.ref === 'ok-1' && f.ok === true)).toBe(true);
        expect(a.frames.some(f => f.type === 'error')).toBe(false);
      } finally {
        delete POST_AUTH_HANDLERS['__test_ok'];
        try { a.ws.close(); } catch { /* ignore */ }
        await handle.shutdown().catch(() => {});
        db.close();
      }
    })();
  }, 20_000);
});

describe('#94: a refused duplicate is not counted as traffic', () => {
  // Pins reason (2) in routeDirect's comment for choosing an explicit lookup
  // over catching the UNIQUE constraint: the check sits ABOVE the
  // accepted-and-routed metrics, so a rejected duplicate never counts as a
  // message the bus carried.
  //
  // Written because the FIRST version of that comment gave a different reason
  // which turned out to be false (it claimed the recipient would already hold
  // the frame by insert time; insertMessage actually runs before
  // recipientWs.send). A stated rationale that nothing tests is just a claim,
  // and that is exactly how the wrong one survived review.
  it('sender counter advances once for two sends sharing a msg_id', async () => {
    const { db, handle, port } = await setup();
    const a = await authConnect(port, 'A', 'ta');
    try {
      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'one', msg_id: 'metric-1' }));
      await wait(120);
      const afterFirst = sentCountFor(db, 'A');

      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'two', msg_id: 'metric-1' }));
      await wait(150);
      const afterDuplicate = sentCountFor(db, 'A');

      expect(afterDuplicate).toBe(afterFirst);

      // Positive control: a genuinely new message DOES advance it, so the
      // assertion above cannot be satisfied by a counter that never moves.
      a.ws.send(JSON.stringify({ type: 'send', to: 'B', payload: 'three', msg_id: 'metric-2' }));
      await wait(150);
      expect(sentCountFor(db, 'A')).toBe(afterFirst + 1);
    } finally {
      try { a.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});
