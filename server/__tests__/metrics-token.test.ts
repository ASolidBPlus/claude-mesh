import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type * as net from 'net';
import { Database } from 'bun:sqlite';
import { openDb } from '../db.ts';
import { startHttpAdmin, type HttpAdminHandle } from '../http-admin.ts';

// R-18 — MESH_METRICS_TOKEN. Unset: /metrics is unauthenticated, exactly as
// before (Prometheus scrapes without a credential until both sides are
// configured). Set: /metrics takes that token or the admin token.

const ADMIN = 'admin-token-r18';
const METRICS = 'metrics-token-r18';

let db: Database | undefined;
let handle: HttpAdminHandle | undefined;
afterEach(async () => {
  await handle?.shutdown().catch(() => {});
  db?.close();
  handle = undefined; db = undefined;
});

async function start(metricsToken: string | null): Promise<{ base: string; lines: string[] }> {
  db = openDb(':memory:');
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-r18-')),
      new Map(), new Map(), new Map(), {}, { metricsToken });
  } finally { console.log = log; }
  return { base: `http://127.0.0.1:${(handle.server.address() as net.AddressInfo).port}`, lines };
}

const get = (url: string, token?: string) =>
  fetch(url, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });

function bootLine(lines: string[]): Record<string, unknown> {
  const found = lines.map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter(o => o?.evt === 'admin.listening');
  expect(found.length).toBe(1);
  return found[0]!;
}

describe('MESH_METRICS_TOKEN unset: today\'s behaviour', () => {
  it('/metrics answers 200 with no credential, and the boot line says metrics_auth "none"', async () => {
    const { base, lines } = await start(null);
    const res = await get(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('# TYPE');
    const boot = bootLine(lines);
    expect(boot.metrics_auth).toBe('none');
    expect(boot.metrics_unauthenticated).toBe(true);
    expect(String(boot.note)).toContain('unauthenticated');
  });
});

describe('MESH_METRICS_TOKEN set', () => {
  it('no credential → 401, and the body is the SAME as an unauthenticated /agents', async () => {
    const { base } = await start(METRICS);
    const metrics = await get(`${base}/metrics`);
    const agents = await get(`${base}/agents`);
    expect(metrics.status).toBe(401);
    expect(agents.status).toBe(401);
    expect(await metrics.text()).toBe(await agents.text());
  });

  it('a wrong token → 401 — including near misses', async () => {
    const { base } = await start(METRICS);
    for (const wrong of ['nope', METRICS.slice(0, -1), `${METRICS}x`, METRICS.toUpperCase()]) {
      expect({ wrong, status: (await get(`${base}/metrics`, wrong)).status }).toEqual({ wrong, status: 401 });
    }
    // Not "Bearer": the scheme is part of the credential format.
    expect((await fetch(`${base}/metrics`, { headers: { Authorization: `Basic ${METRICS}` } })).status).toBe(401);
  });

  it('the metrics token → 200 with metrics; the admin token → 200 too', async () => {
    const { base } = await start(METRICS);
    const viaMetrics = await get(`${base}/metrics`, METRICS);
    expect(viaMetrics.status).toBe(200);
    expect(await viaMetrics.text()).toContain('# TYPE');
    expect((await get(`${base}/metrics`, ADMIN)).status).toBe(200);
  });

  it('the metrics token is ONLY for /metrics — it does not open an admin route', async () => {
    const { base } = await start(METRICS);
    expect((await get(`${base}/agents`, METRICS)).status).toBe(401);
    expect((await get(`${base}/agents`, ADMIN)).status).toBe(200);
  });

  it('the boot line says metrics_auth "token", drops metrics_unauthenticated, and never carries the token', async () => {
    const { lines } = await start(METRICS);
    const boot = bootLine(lines);
    expect(boot.metrics_auth).toBe('token');
    expect('metrics_unauthenticated' in boot).toBe(false);
    expect(String(boot.note)).toContain('requires MESH_METRICS_TOKEN');
    expect(lines.join('\n')).not.toContain(METRICS);
  });

  it('a refused request logs nothing about the presented credential', async () => {
    const { base } = await start(METRICS);
    const seen: string[] = [];
    const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
    try {
      await get(`${base}/metrics`, 'presented-guess-123');
      await get(`${base}/metrics`, METRICS);
    } finally { console.log = log; console.error = err; }
    const all = seen.join('\n');
    expect(all).not.toContain('presented-guess-123');
    expect(all).not.toContain(METRICS);
  });
});
