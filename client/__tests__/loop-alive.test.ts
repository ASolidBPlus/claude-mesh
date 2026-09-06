import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb, registerAgent, getAgentById } from '../../server/db.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { hashToken } from '../../server/auth.ts';
import { MeshClient } from '../src/client.ts';

// #133 follow-up — the emitter needs a door.
//
// #147 added the `loop_alive` frame server-side, and the plugin that must send
// it (spawner#346) had none: every public method on MeshClient awaits an ack,
// and the socket is private. The obvious workaround is actively harmful —
// a second socket to emit the frame would, under #145's newer-wins, DISPLACE
// the plugin's primary socket. A feature reachable only by breaking the
// connection it reports on is not reachable.
describe('#133 MeshClient.loopAlive()', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let client: MeshClient | undefined;

  beforeEach(async () => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'looper', token_hash: hashToken('tok-loop'), hostname: 'h' });
    handle = await startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-loopalive-')));
    port = (handle.wss.address() as { port: number }).port;
  });
  afterEach(async () => {
    try { client?.close(); } catch { /* ignore */ }
    client = undefined;
    await handle.shutdown().catch(() => {});
    db?.close();
  });

  const connect = async (): Promise<MeshClient> => {
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'looper', agentToken: 'tok-loop' });
    await c.connect();
    return c;
  };

  it('advances last_responded on the server', async () => {
    client = await connect();
    expect(getAgentById(db, 'looper')!.last_responded).toBeNull();

    client.loopAlive();
    await new Promise((r) => setTimeout(r, 150));

    const row = getAgentById(db, 'looper')!;
    expect(row.last_responded).not.toBeNull();
    expect(typeof row.last_responded).toBe('number');
  }, 20_000);

  // THE CONTROL THAT MATTERS, and the reason this method exists rather than the
  // caller opening its own connection. Under #145 a second authenticated socket
  // for the same agent id DISPLACES the first — so an emitter that connected
  // separately would knock the plugin's primary socket off the bus every beat.
  // This asserts the frame goes out on the socket that is already there.
  it('CONTROL: sends on the EXISTING socket — no second connection', async () => {
    client = await connect();
    await new Promise((r) => setTimeout(r, 100));

    expect(handle.wss.clients.size).toBe(1);
    // The IDENTITY of the indexed socket, captured before. Counting is not
    // enough and I proved it: a mutant that opened a second socket per beat
    // passed a count-and-defined assertion, because under #145 each new socket
    // DISPLACES the previous one — the count returns to 1 and agentIndex is
    // still defined, pointing at the newest. Both of those are true in exactly
    // the case the control exists to reject.
    const socketBefore = handle.agentIndex.get('looper');
    expect(socketBefore).toBeDefined();

    client.loopAlive();
    client.loopAlive();
    client.loopAlive();
    await new Promise((r) => setTimeout(r, 150));

    expect(handle.wss.clients.size).toBe(1);
    // The SAME socket object, not merely a socket: displacement swaps it.
    expect(handle.agentIndex.get('looper')).toBe(socketBefore);
    expect(getAgentById(db, 'looper')!.last_responded).not.toBeNull();
  }, 20_000);

  // A liveness beat must not become an error path. The caller is a turn loop,
  // not error-handling code: making it wrap every beat in a try/catch invites
  // the catch that swallows everything. A missed beat is already
  // indistinguishable from a stale one — both leave last_responded behind.
  it('is a no-op when not connected, not a throw', () => {
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'looper', agentToken: 'tok-loop' });
    expect(() => c.loopAlive()).not.toThrow();
    // ...and it stamped nothing, because nothing was sent.
    expect(getAgentById(db, 'looper')!.last_responded).toBeNull();
  });

  it('is a no-op after close(), not a throw', async () => {
    client = await connect();
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(() => client!.loopAlive()).not.toThrow();
  }, 20_000);
});
