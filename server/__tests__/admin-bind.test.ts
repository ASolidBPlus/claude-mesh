import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as net from 'net';
import { openDb } from '../db.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';

// #127 — MESH_ADMIN_BIND makes the "/metrics is internal-only" premise
// falsifiable.
//
// C9 exempts /metrics' per-cause counters on the premise that the admin port is
// internal-only. Before this, the process did the OPPOSITE of what the premise
// needs — bound every interface — and nothing in the system knew whether the
// network controls making it true were present. That is an ASSUMPTION:
// checkable by nobody. A bind address plus a boot log naming it makes it
// CONFIGURATION: checkable by the deployer, at boot.
//
// NOT a loopback default, deliberately: inside the container the spawner stack
// reaches both ports over the Docker network, so a loopback default would make
// the mesh unreachable in production. The default here must stay "all
// interfaces", which is why the unchanged-default test below is the one that
// matters most.
describe('#127 MESH_ADMIN_BIND', () => {
  let db: Database;
  let handle: HttpAdminHandle | undefined;
  const ADMIN = 'admin-token-for-tests';
  const saved = process.env.MESH_ADMIN_BIND;

  const start = async (): Promise<HttpAdminHandle> => startHttpAdmin(
    0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-127-')),
    new Map(), new Map(), new Map(),
  );

  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    handle = undefined;
    db?.close();
    if (saved === undefined) delete process.env.MESH_ADMIN_BIND;
    else process.env.MESH_ADMIN_BIND = saved;
  });

  it('set: the listener binds the address it was given', async () => {
    process.env.MESH_ADMIN_BIND = '127.0.0.1';
    handle = await start();
    const addr = handle.server.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  // THE ONE THAT MATTERS MOST. A loopback default would be a production
  // outage, so the default must be exactly what it was before this change:
  // every interface. `::` is what listen(port) binds, measured — this asserts
  // the new code path reproduces it rather than trusting that it does.
  it('DEFAULT unset: unchanged — still every interface', async () => {
    delete process.env.MESH_ADMIN_BIND;
    handle = await start();
    const addr = handle.server.address() as net.AddressInfo;
    expect(addr.address).toBe('::');
  });

  // POSITIVE CONTROL for the test above: without it, a mutant that ignored the
  // env var entirely would pass the default case and look correct. The two
  // together say the variable is read AND the default is preserved.
  it('CONTROL: the two cases actually differ', async () => {
    delete process.env.MESH_ADMIN_BIND;
    const a = await start();
    const defaultAddr = (a.server.address() as net.AddressInfo).address;
    await a.shutdown().catch(() => {});

    process.env.MESH_ADMIN_BIND = '127.0.0.1';
    handle = await start();
    const boundAddr = (handle.server.address() as net.AddressInfo).address;

    expect(defaultAddr).not.toBe(boundAddr);
  });

  it('the boot log names the bind AND that /metrics is unauthenticated on it', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      process.env.MESH_ADMIN_BIND = '127.0.0.1';
      handle = await start();
    } finally {
      console.log = realLog;
    }

    const boot = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
                      .find(o => o !== null && o.evt === 'admin.listening');
    expect(boot).toBeDefined();
    expect(boot!.bind).toBe('127.0.0.1');
    // The disclosure is the point of the line: a deployer reading it is being
    // told what is reachable and that it is unauthenticated.
    expect(boot!.metrics_unauthenticated).toBe(true);
    expect(String(boot!.bound)).toContain('127.0.0.1');
  });

  it('unset: the boot log SAYS it is bound to all interfaces, rather than staying silent', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      delete process.env.MESH_ADMIN_BIND;
      handle = await start();
    } finally {
      console.log = realLog;
    }

    const boot = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
                      .find(o => o !== null && o.evt === 'admin.listening');
    expect(boot).toBeDefined();
    expect(boot!.bind).toBe('(all interfaces)');
    // Silence here would leave the premise exactly as unfalsifiable as before:
    // the whole value of the default case is that the deployer is TOLD.
    expect(String(boot!.note)).toContain('ALL interfaces');
    expect(String(boot!.note)).toContain('unauthenticated');
  });
});
