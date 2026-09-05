import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, setOnline, getAgentById, listAgents } from '../db.ts';
import { startWsServer } from '../ws-server.ts';
import { unlinkSync } from 'fs';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #87 — `online` is a claim about a live socket stored in a durable table, so
// it outlives the process that could vouch for it. Only the connect/disconnect
// handlers wrote it, and a disconnect handler cannot run for a socket that died
// with the server. So every agent that was connected at restart and does not
// come back read as online forever.
//
// These drive the REAL startup path (startWsServer) rather than calling
// clearAllOnline: a test that called the helper would stay green if the call
// were removed from startup, which is the only place the invariant matters.

describe('#87: stale online flags are cleared at startup', () => {
  it('clears online=1 rows left by a previous process, via the real startup path', async () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'ghost-a', token_hash: 'a'.repeat(64), hostname: 'h1' });
    registerAgent(db, { id: 'ghost-b', token_hash: 'b'.repeat(64), hostname: 'h2' });
    registerAgent(db, { id: 'never-on', token_hash: 'c'.repeat(64), hostname: 'h3' });
    // The post-crash state: the DB says connected, no socket exists.
    setOnline(db, 'ghost-a', true);
    setOnline(db, 'ghost-b', true);

    expect(listAgents(db).filter(a => a.online === 1).length).toBe(2);

    const handle = await startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-87-')), 0);
    try {
      expect(getAgentById(db, 'ghost-a')?.online).toBe(0);
      expect(getAgentById(db, 'ghost-b')?.online).toBe(0);
      expect(getAgentById(db, 'never-on')?.online).toBe(0);
      // Nothing is connected, so the roster agrees with the world.
      expect(listAgents(db).filter(a => a.online === 1).length).toBe(0);
    } finally {
      await handle.shutdown().catch(() => {});
    }
    db.close();
  });

  it('survives a real close/reopen of an on-disk database — the actual restart', async () => {
    // The :memory: cases above prove the reset runs. This one proves the
    // problem it solves is real: the flag genuinely persists across a close and
    // reopen of the same file, so the reset is not defending against nothing.
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mesh-87-disk-')), 'mesh.sqlite');
    let db = openDb(dbPath);
    registerAgent(db, { id: 'ghost-disk', token_hash: 'd'.repeat(64), hostname: 'h4' });
    setOnline(db, 'ghost-disk', true);
    db.close();

    // Reopening alone does NOT fix it — the positive control for the bug.
    db = openDb(dbPath);
    expect(getAgentById(db, 'ghost-disk')?.online).toBe(1);

    // Starting the server does.
    const handle = await startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-87-f-')), 0);
    try {
      expect(getAgentById(db, 'ghost-disk')?.online).toBe(0);
    } finally {
      await handle.shutdown().catch(() => {});
    }
    db.close();
    try { unlinkSync(dbPath); } catch { /* best effort */ }
  });

  it('does not disturb last_seen or last_alive — only the liveness claim is reset', async () => {
    // The reset must not look like activity. last_seen answers "when did it
    // last act" and last_alive "when was it last alive" (#67); a boot-time
    // write to either would forge evidence about an agent that isn't there.
    const db = openDb(':memory:');
    registerAgent(db, { id: 'stamped', token_hash: 'e'.repeat(64), hostname: 'h5' });
    setOnline(db, 'stamped', true);
    const before = getAgentById(db, 'stamped')!;

    const handle = await startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-87-s-')), 0);
    try {
      const after = getAgentById(db, 'stamped')!;
      expect(after.online).toBe(0);
      expect(after.last_seen).toBe(before.last_seen);
      expect(after.last_alive).toBe(before.last_alive);
    } finally {
      await handle.shutdown().catch(() => {});
    }
    db.close();
  });
});
