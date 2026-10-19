import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as net from 'net';
import { randomBytes } from 'crypto';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, aclGrant, insertFile } from '../db.ts';
import { hashToken } from '../auth.ts';
import { routeFile } from '../router.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, type HttpAdminHandle } from '../http-admin.ts';
import { setDownloadLimits, DOWNLOAD_LIMITS } from '../admin-files.ts';

// R-271 — file downloads are BOUNDED (concurrency per agent and globally, a
// typed 429 past either), STREAMED rather than read into memory, and the WS
// door's refused tokens are logged (rate-limited, never the token). Stored
// files are 0600 and the files directory 0700, whatever the umask.
//
// A download is held open by a RAW client that sends the request and never
// reads: TCP backpressure stops the server's stream, so the slot stays taken
// for as long as the test wants — no test seam into the handler.

const ADMIN = 'admin-r271';
// Below the ephemeral range (32768+).
const port = () => 23000 + Math.floor(Math.random() * 1900);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const BIG = 24 * 1024 * 1024;   // larger than loopback socket buffers, so a non-reading client blocks the stream

let db: Database | undefined;
const closers: (() => Promise<void> | void)[] = [];
const realLog = console.log;
afterEach(async () => {
  console.log = realLog;
  for (const c of closers.splice(0).reverse()) await c();
  setDownloadLimits(DOWNLOAD_LIMITS);
  db?.close(); db = undefined;
});

function fixture(): { filesDir: string; big: string; small: string; smallBytes: Buffer } {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob', 'carol']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  aclGrant(db, 'alice', 'bob', 'admin');
  const filesDir = mkdtempSync(join(tmpdir(), 'r271-files-'));
  const big = 'big-file-id';
  writeFileSync(join(filesDir, big), Buffer.alloc(BIG, 0x61));
  insertFile(db, { id: big, from_agent: 'alice', to_agent: 'bob', filename: 'big.bin', content_type: 'application/octet-stream',
    size_bytes: BIG, file_path: join(filesDir, big), sent_at: Date.now(), expires_at: null });
  const smallBytes = randomBytes(3 * 1024 * 1024 + 7);
  const r = routeFile(db, new Map(), 'alice', { type: 'file_send', msg_id: 's1', to: 'bob', filename: 'report "q3".pdf', content_type: 'application/pdf', data: smallBytes.toString('base64') } as never, 10_485_760, filesDir);
  if (!r.ok || r.fileId === undefined) throw new Error('fixture file not stored');
  return { filesDir, big, small: r.fileId, smallBytes };
}

async function adminServer(filesDir: string): Promise<string> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  const h: HttpAdminHandle = await startHttpAdmin(0, db!, ADMIN, 10_485_760, filesDir);
  closers.push(() => h.shutdown().catch(() => {}));
  return `http://127.0.0.1:${(h.server.address() as net.AddressInfo).port}`;
}

/** A download that is REQUESTED and then never read: it holds its slot. */
async function hold(base: string, fileId: string, token: string, from?: string): Promise<{ status: () => string; abort: () => void }> {
  const u = new URL(base);
  const s = net.connect({ host: u.hostname, port: Number(u.port), ...(from ? { localAddress: from } : {}) });
  await new Promise<void>(r => s.once('connect', () => r()));
  s.on('error', () => {});
  let head = '';
  s.on('data', (d: Buffer) => { if (head.length < 200) head += d.toString('latin1'); s.pause(); });   // read ONE chunk, then stop
  s.write(`GET /files/${fileId} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\n\r\n`);
  await wait(250);
  closers.push(() => { s.destroy(); });
  return { status: () => head.split('\r\n')[0] ?? '', abort: () => s.destroy() };
}

const get = (base: string, path: string, token?: string) => fetch(`${base}${path}`, token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } });

describe('R-271: concurrent downloads are capped — per agent, and globally', () => {
  it('per agent: the next download by the SAME agent gets a typed 429 with Retry-After; another agent is unaffected; an ABORT frees the slot', async () => {
    const { filesDir, big, small } = fixture();
    setDownloadLimits({ global: 10, perAgent: 2 });
    const base = await adminServer(filesDir);
    const h1 = await hold(base, big, 'bob-tok');
    const h2 = await hold(base, big, 'bob-tok');
    expect([h1.status(), h2.status()]).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK']);   // both really streaming

    const busy = await get(base, `/files/${small}`, 'bob-tok');
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ error: 'too many concurrent downloads; retry shortly', code: 'DOWNLOAD_BUSY' });
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);

    expect((await get(base, `/files/${small}`, 'alice-tok')).status).toBe(200);           // the sender is another agent

    h1.abort();
    await wait(300);
    expect((await get(base, `/files/${small}`, 'bob-tok')).status).toBe(200);             // the aborted download's slot is free
  }, 30_000);

  it('global: refused across agents once the total is reached; the ADMIN token counts against the global cap only', async () => {
    const { filesDir, big, small } = fixture();
    setDownloadLimits({ global: 2, perAgent: 5 });
    const base = await adminServer(filesDir);
    await hold(base, big, 'bob-tok');
    await hold(base, big, 'alice-tok');
    const r1 = await get(base, `/files/${small}`, ADMIN);
    expect(r1.status).toBe(429);
    expect((await r1.json()).code).toBe('DOWNLOAD_BUSY');
    expect((await get(base, `/files/${small}`, 'bob-tok')).status).toBe(429);
  }, 30_000);

  it('the admin token is NOT subject to a per-agent cap', async () => {
    const { filesDir, big, small } = fixture();
    setDownloadLimits({ global: 10, perAgent: 1 });
    const base = await adminServer(filesDir);
    await hold(base, big, ADMIN);
    expect((await get(base, `/files/${small}`, ADMIN)).status).toBe(200);
  }, 30_000);

  it('completion releases the slot: many sequential downloads at a per-agent cap of 1', async () => {
    const { filesDir, small } = fixture();
    setDownloadLimits({ global: 1, perAgent: 1 });
    const base = await adminServer(filesDir);
    for (let i = 0; i < 6; i++) {
      const res = await get(base, `/files/${small}`, 'bob-tok');
      expect({ i, s: res.status }).toEqual({ i, s: 200 });
      await res.arrayBuffer();
    }
  });

  it('an ERROR releases the slot: a file whose bytes are missing on disk 404s and does not leak', async () => {
    const { filesDir } = fixture();
    insertFile(db!, { id: 'ghost', from_agent: 'alice', to_agent: 'bob', filename: 'g', content_type: 'text/plain',
      size_bytes: 3, file_path: join(filesDir, 'ghost-missing-on-disk'), sent_at: Date.now(), expires_at: null });
    setDownloadLimits({ global: 1, perAgent: 1 });
    const base = await adminServer(filesDir);
    for (let i = 0; i < 3; i++) expect((await get(base, '/files/ghost', 'bob-tok')).status).toBe(404);
    // and the cap is still usable
    const { small } = { small: (db!.prepare("SELECT id FROM files WHERE id != 'ghost' AND id != 'big-file-id'").get() as { id: string }).id };
    expect((await get(base, `/files/${small}`, 'bob-tok')).status).toBe(200);
  });

  it('a refused or unauthorised request takes no slot (404 for another agent leaves the cap free)', async () => {
    const { filesDir, small } = fixture();
    setDownloadLimits({ global: 1, perAgent: 1 });
    const base = await adminServer(filesDir);
    for (let i = 0; i < 3; i++) expect((await get(base, `/files/${small}`, 'carol-tok')).status).toBe(404);
    expect((await get(base, `/files/${small}`, 'bob-tok')).status).toBe(200);
  });
});

describe('R-271: the body is streamed — byte-identical, headers unchanged', () => {
  it('bytes, Content-Type, Content-Disposition and Content-Length are exactly as before', async () => {
    const { filesDir, small, smallBytes } = fixture();
    const base = await adminServer(filesDir);
    const res = await get(base, `/files/${small}`, 'bob-tok');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-length')).toBe(String(smallBytes.length));
    expect(res.headers.get('content-disposition')).toContain('report');
    expect(Buffer.from(await res.arrayBuffer()).equals(smallBytes)).toBe(true);
  });
});

describe('R-271: the WS-port door logs refused tokens — once per source per window, never the token', () => {
  it('five refusals from one address → ONE line; the bad token never appears; a no-token refusal from another address gets its own line', async () => {
    const { filesDir, small } = fixture();
    const p = port();
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    const h: WsServerHandle = await startWsServer(p, db!, 10_485_760, filesDir);
    closers.push(() => h.shutdown().catch(() => {}));
    const SENTINEL = 'SENTINEL-bad-token-7f3a91';
    const statuses: number[] = [];
    // The BAD token goes first, so it is the refusal that is LOGGED: a sentinel
    // that only ever reached suppressed requests would prove nothing.
    for (const tok of [SENTINEL, undefined, SENTINEL, undefined, SENTINEL]) {
      statuses.push((await get(`http://127.0.0.1:${p}`, `/files/${small}`, tok)).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    const refused = lines.flatMap(l => { try { const o = JSON.parse(l); return o?.evt === 'agent.http' && o.refused ? [o] : []; } catch { return []; } });
    expect(refused).toMatchObject([{ refused: 'bad_token', route: 'GET /files/:id', src_ip: '127.0.0.1', listener: 'ws' }]);
    expect(lines.join('\n')).not.toContain(SENTINEL);
    expect(refused[0]!.suppressed_since_last).toBe(0);
    // Another source address is its own window, and a request with no
    // Authorization header at all is named as such.
    const from2 = net.connect({ host: '127.0.0.1', port: p, localAddress: '127.0.0.2' });
    await new Promise<void>(r => from2.once('connect', () => r()));
    from2.write(`GET /files/${small} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    await new Promise<void>(r => { from2.once('close', () => r()); from2.on('data', () => {}); });
    const again = lines.flatMap(l => { try { const o = JSON.parse(l); return o?.evt === 'agent.http' && o.refused ? [o] : []; } catch { return []; } });
    expect(again.map(e => [e.refused, e.src_ip])).toEqual([['bad_token', '127.0.0.1'], ['no_token', '127.0.0.2']]);
  });
});

describe('R-271: stored files are 0600 and the files directory 0700 — whatever the umask', () => {
  it('a WS upload (file_send) and an admin upload are 0600 under umask 000', async () => {
    const old = process.umask(0o000);
    try {
      const { filesDir, small } = fixture();
      expect(statSync(join(filesDir, small)).mode & 0o777).toBe(0o600);
      const base = await adminServer(filesDir);
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('admin upload')]), 'a.txt');
      form.append('from_agent', 'alice');
      form.append('to_agent', 'bob');
      const res = await fetch(`${base}/files`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` }, body: form });
      expect(res.status).toBe(201);
      const { file_id } = await res.json() as { file_id: string };
      expect(statSync(join(filesDir, file_id)).mode & 0o777).toBe(0o600);
    } finally { process.umask(old); }
  });

  it('the server creates MESH_FILES_DIR 0700 under umask 000 (the real server)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'r271-e2e-'));
    const filesDir = join(root, 'files', 'nested');
    const p = port();
    const old = process.umask(0o000);
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'server.ts')], {
      env: { ...process.env, MESH_ADMIN_TOKEN: ADMIN, MESH_DB_PATH: join(root, 'm.db'), MESH_FILES_DIR: filesDir, MESH_WS_PORT: String(p), MESH_ADMIN_PORT: String(p + 1) },
      stdout: 'ignore', stderr: 'ignore',
    });
    process.umask(old);
    try {
      for (let i = 0; i < 60; i++) { await wait(250); try { await fetch(`http://127.0.0.1:${p}/healthz`); break; } catch { /* booting */ } }
      expect(statSync(filesDir).mode & 0o777).toBe(0o700);
    } finally { proc.kill(); await proc.exited; }
  }, 30_000);
});

describe('R-271: streaming does not stall shutdown', () => {
  // On Bun, server.close() called while a STREAMED response is still
  // finishing never completes once the connection goes idle (measured: it hung
  // for good; res.end(buffer) never did). Every graceful shutdown would wait
  // on the last download forever. shutdown() now sweeps idle connections and
  // closes the rest after a short grace.
  it('shutdown completes promptly right after a streamed download (the reproduced hang)', async () => {
    // The exact shape that reproduced it every time: a SMALL file (the
    // response finishes within microseconds of the client having the bytes),
    // fetched once, shutdown called the moment the body is read.
    const { filesDir } = fixture();
    const tiny = join(filesDir, 'tiny');
    await Bun.write(tiny, new TextEncoder().encode('file body bytes'));
    insertFile(db!, { id: 'tiny', from_agent: 'alice', to_agent: 'bob', filename: 't.md', content_type: 'text/markdown',
      size_bytes: 15, file_path: tiny, sent_at: Date.now(), expires_at: null });
    console.log = () => {};
    const h = await startHttpAdmin(0, db!, ADMIN, 10_485_760, filesDir);
    const base = `http://localhost:${(h.server.address() as net.AddressInfo).port}`;
    const res = await get(base, '/files/tiny', 'bob-tok');
    await res.arrayBuffer();
    const t = Date.now();
    const outcome = await Promise.race([h.shutdown().then(() => 'closed'), wait(3000).then(() => 'hung')]);
    expect(outcome).toBe('closed');
    expect(Date.now() - t).toBeLessThan(500);    // the idle sweep (~50 ms), not the 1 s grace
  });

  it('a download a client is stalling does not hold shutdown beyond the grace', async () => {
    const { filesDir, big } = fixture();
    console.log = () => {};
    const h = await startHttpAdmin(0, db!, ADMIN, 10_485_760, filesDir);
    const base = `http://127.0.0.1:${(h.server.address() as net.AddressInfo).port}`;
    await hold(base, big, 'bob-tok');
    const t = Date.now();
    const outcome = await Promise.race([h.shutdown().then(() => 'closed'), wait(4000).then(() => 'hung')]);
    expect(outcome).toBe('closed');
    expect(Date.now() - t).toBeLessThan(2000);
  }, 20_000);
});
