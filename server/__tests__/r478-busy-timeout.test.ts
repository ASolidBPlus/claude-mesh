// R-478: openDb sets a busy timeout, so a brief lock held by another
// connection delays a write instead of failing it. The guard pinned here,
// with a mutant in the PR: the real server boots against a database whose
// write lock another connection holds (BEGIN IMMEDIATE) while it starts, and
// it comes up once the lock is released. Without the timeout its first write
// fails at once with "database is locked".
import { describe, it, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { openDb, registerAgent, DB_BUSY_TIMEOUT_MS } from '../db.ts';
import { hashToken } from '../auth.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup } = tempDirs();
afterAll(cleanup);
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
let portCounter = 24500;

// Held for longer than the server takes to reach its first write, so the
// write lands inside the lock, and well under DB_BUSY_TIMEOUT_MS.
const HOLD_MS = 1500;

describe('R-478 busy_timeout', () => {
  it('openDb sets it, before anything else', () => {
    const db = openDb(':memory:');
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(DB_BUSY_TIMEOUT_MS);
    expect(HOLD_MS).toBeLessThan(DB_BUSY_TIMEOUT_MS);
    db.close(true);
  });

  it('GUARD: the server boots while another connection holds the write lock, once it is released', async () => {
    const path = join(tmp('r478-'), 'mesh.db');
    const seed = openDb(path);
    registerAgent(seed, { id: 'fred', token_hash: hashToken('fred-tok'), hostname: 'h' });
    seed.close(true);

    const holder = new Database(path);
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE agents SET last_seen = last_seen WHERE id = ?').run('fred');
    let released = false;
    const release = delay(HOLD_MS).then(() => { holder.exec('COMMIT'); released = true; });

    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'server.ts')], {
      env: { ...process.env, MESH_ADMIN_TOKEN: 'adm', MESH_DB_PATH: path, MESH_FILES_DIR: join(path, '..', 'files'), MESH_WS_PORT: String(portCounter++), MESH_ADMIN_PORT: String(portCounter++) },
      stdout: 'pipe', stderr: 'pipe',
    });
    // Up = the boot line that follows opening the database and starting the
    // listeners; or the process exits (a failed boot).
    let out = '';
    const reader = proc.stdout.getReader();
    const up = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        out += dec.decode(value);
        if (out.includes('"evt":"mesh.listeners"')) return true;
      }
    })();
    const result = await Promise.race([up, proc.exited.then(() => false), delay(10_000).then(() => false)]);
    const stderr = result ? '' : await new Response(proc.stderr).text().catch(() => '');
    proc.kill();
    await release;
    holder.close(true);
    expect({ up: result, stderr: stderr.slice(0, 300) }).toEqual({ up: true, stderr: '' });
    expect(released).toBe(true);
  }, 20_000);
});
