import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as os from 'os';
import WebSocket from 'ws';
import { openDb, registerAgent } from '../db.ts';
import { startWsServer } from '../ws-server.ts';
import { hashToken } from '../auth.ts';

// MESH_WS_BIND — #139 shipped the variable with no boot line and no test, while
// the admin port had both. That asymmetry is the wrong way round: the WS port is
// the one every agent and peering must reach, so restricting it has reachability
// consequences the admin port does not, and a deployer had nothing to see.
describe('MESH_WS_BIND', () => {
  let db: Database;
  let handle: Awaited<ReturnType<typeof startWsServer>> | undefined;
  const saved = process.env.MESH_WS_BIND;

  const start = async () => startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-wsbind-')));

  beforeEach(() => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'a-one', token_hash: hashToken('tok-a'), hostname: 'h' });
  });
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    handle = undefined;
    db?.close();
    if (saved === undefined) delete process.env.MESH_WS_BIND;
    else process.env.MESH_WS_BIND = saved;
  });

  /** A non-loopback IPv4 address of this host, if it has one. */
  function externalIPv4(): string | null {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
    return null;
  }

  const canConnect = (url: string): Promise<boolean> => new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    // `on`, not `once`: a refused connection errors, and CLOSING it then emits a
    // second error. With `once` that second one has no listener and bun turns it
    // into an unhandled-error failure — so the test would report a crash where
    // the refusal it is asserting had actually happened.
    ws.on('error', () => { if (!settled) { settled = true; resolve(false); } });
    ws.on('open', () => {
      if (!settled) { settled = true; resolve(true); }
      try { ws.close(); } catch { /* ignore */ }
    });
    setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch { /* ignore */ } resolve(false); } }, 2500);
  });

  // THE REAL RESTRICTION, not merely the reported address. A test that only
  // read server.address() would pass against a server that recorded the host
  // and bound everything anyway.
  it('set to loopback: loopback connects, the external address does not', async () => {
    const external = externalIPv4();
    if (external === null) return;              // single-interface host: nothing to prove

    process.env.MESH_WS_BIND = '127.0.0.1';
    handle = await start();
    const port = (handle.wss.address() as { port: number }).port;

    expect(await canConnect(`ws://127.0.0.1:${port}`)).toBe(true);
    expect(await canConnect(`ws://${external}:${port}`)).toBe(false);
  }, 20_000);

  // POSITIVE CONTROL for the test above: unset, the SAME external address DOES
  // connect. Without it, "the external address does not connect" could equally
  // mean the address is wrong, the firewall blocks it, or the server is broken.
  it('CONTROL: unset, the same external address connects', async () => {
    const external = externalIPv4();
    if (external === null) return;

    delete process.env.MESH_WS_BIND;
    handle = await start();
    const port = (handle.wss.address() as { port: number }).port;

    expect(await canConnect(`ws://${external}:${port}`)).toBe(true);
  }, 20_000);

  it('the boot line names the bind and the port', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.env.MESH_WS_BIND = '127.0.0.1';
      handle = await start();
    } finally {
      console.log = realLog;
    }
    const boot = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
                      .find(o => o !== null && o.evt === 'ws.listening');
    expect(boot).toBeDefined();
    expect(boot!.bind).toBe('127.0.0.1');
    expect(String(boot!.bound)).toContain('127.0.0.1');
  }, 20_000);

  // The default case is the one that needs telling: a line that only appears
  // once someone has already restricted the port informs nobody.
  it('unset: the boot line SAYS all interfaces rather than staying silent', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      delete process.env.MESH_WS_BIND;
      handle = await start();
    } finally {
      console.log = realLog;
    }
    const boot = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
                      .find(o => o !== null && o.evt === 'ws.listening');
    expect(boot).toBeDefined();
    expect(boot!.bind).toBe('(all interfaces)');
    expect(String(boot!.note)).toContain('ALL interfaces');
  }, 20_000);
});
