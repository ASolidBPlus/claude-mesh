import { describe, it, expect } from 'bun:test';
import { openDb, insertFile, markFileDelivered, getFile, deleteExpiredFiles, sweepFileRetention } from '../db.ts';
import { startCleanup } from '../cleanup.ts';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #39 — the files twin of #34 (fixed for messages in #40).
//
// Before the split, deleteExpiredFiles deleted on `expires_at < now` with NO
// delivered_at condition and the caller unlinked the returned paths, so a
// DELIVERED file's row and bytes both vanished ~5 minutes after acceptance:
// the delivery TTL was destroying history.
//
// After the split: `expires_at` gates deliverability of UNDELIVERED files only;
// delivered files are history and leave only via the retention sweep, which
// keeps sweepRetention's still-deliverable exclusion so a pending file to a
// long-offline agent is never destroyed by age alone.
//
// Every assertion here checks BOTH halves — the row AND the bytes on disk —
// because this table's state lives in two places and either half surviving
// alone is a defect (an orphan row reads as corruption; orphan bytes leak).

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-files-retention-'));
  const p = join(dir, name);
  writeFileSync(p, 'x');
  return p;
}

function addFile(
  db: ReturnType<typeof openDb>,
  id: string,
  opts: { sent_at: number; expires_at: number | null; delivered?: boolean }
): string {
  const file_path = tempFile(id);
  insertFile(db, {
    id,
    from_agent: 'agent-a',
    to_agent: 'agent-b',
    filename: `${id}.txt`,
    content_type: 'text/plain',
    size_bytes: 1,
    file_path,
    sent_at: opts.sent_at,
    expires_at: opts.expires_at,
  });
  if (opts.delivered) markFileDelivered(db, id);
  return file_path;
}

describe('#39 files: delivery TTL vs retention', () => {
  it('a DELIVERED file survives past its TTL — row and bytes (the regression)', async () => {
    const db = openDb(':memory:');
    const path = addFile(db, 'delivered-expired', {
      sent_at: Date.now() - 10_000,
      expires_at: Date.now() - 5_000,
      delivered: true,
    });

    // Retention unset ⇒ nothing is old enough to sweep and history is kept
    // forever; the only thing that could remove this file is the TTL, which
    // is exactly what must no longer touch it.
    const handle = startCleanup(db, new Map<string, WebSocket>(), 50);
    await wait(120);
    handle.stop();

    expect(getFile(db, 'delivered-expired')).not.toBeNull();
    expect(existsSync(path)).toBe(true);

    db.close();
  });

  it('an UNDELIVERED file still expires at its TTL — row and bytes', async () => {
    const db = openDb(':memory:');
    const path = addFile(db, 'undelivered-expired', {
      sent_at: Date.now() - 10_000,
      expires_at: Date.now() - 5_000,
    });

    const handle = startCleanup(db, new Map<string, WebSocket>(), 50);
    await wait(120);
    handle.stop();

    expect(getFile(db, 'undelivered-expired')).toBeNull();
    expect(existsSync(path)).toBe(false);

    db.close();
  });

  it('the retention sweep removes old DELIVERED files — row and bytes', async () => {
    const db = openDb(':memory:');
    const path = addFile(db, 'delivered-old', {
      sent_at: Date.now() - 10_000,
      expires_at: null,
      delivered: true,
    });

    // retentionMs = 1s ⇒ a 10s-old delivered file is past the window.
    const handle = startCleanup(db, new Map<string, WebSocket>(), 50, 1_000);
    await wait(120);
    handle.stop();

    expect(getFile(db, 'delivered-old')).toBeNull();
    expect(existsSync(path)).toBe(false);

    db.close();
  });

  it('a STILL-DELIVERABLE pending file survives retention regardless of age', async () => {
    const db = openDb(':memory:');
    // Old enough to be swept on age alone, but undelivered and unexpired:
    // durable pending mail to a long-offline agent. Retention must not eat it.
    const noExpiry = addFile(db, 'pending-no-expiry', { sent_at: Date.now() - 10_000, expires_at: null });
    const future = addFile(db, 'pending-future-expiry', {
      sent_at: Date.now() - 10_000,
      expires_at: Date.now() + 60_000,
    });

    const handle = startCleanup(db, new Map<string, WebSocket>(), 50, 1_000);
    await wait(120);
    handle.stop();

    expect(getFile(db, 'pending-no-expiry')).not.toBeNull();
    expect(existsSync(noExpiry)).toBe(true);
    expect(getFile(db, 'pending-future-expiry')).not.toBeNull();
    expect(existsSync(future)).toBe(true);

    db.close();
  });

  // Ordering. Both removal paths must delete the row and only THEN unlink: a
  // crash between the two leaves bytes without a row (a recoverable leak),
  // never a row without bytes (which reads as corruption to every consumer).
  //
  // Asserted structurally rather than by proxy — each db-level function is
  // called on its own, and at the instant it returns the row is already gone
  // while the bytes are still present. The unlink can therefore only happen
  // after the delete, because it hasn't happened yet.
  it('deleteExpiredFiles removes the row before any unlink, returning the path', () => {
    const db = openDb(':memory:');
    const path = addFile(db, 'order-ttl', { sent_at: Date.now() - 10_000, expires_at: Date.now() - 5_000 });

    const paths = deleteExpiredFiles(db);

    expect(paths).toEqual([path]);
    expect(getFile(db, 'order-ttl')).toBeNull();
    expect(existsSync(path)).toBe(true); // unlink is the caller's job, after this returns

    db.close();
  });

  it('sweepFileRetention removes the row before any unlink, returning the path', () => {
    const db = openDb(':memory:');
    const path = addFile(db, 'order-retention', {
      sent_at: Date.now() - 10_000,
      expires_at: null,
      delivered: true,
    });

    const paths = sweepFileRetention(db, 1_000);

    expect(paths).toEqual([path]);
    expect(getFile(db, 'order-retention')).toBeNull();
    expect(existsSync(path)).toBe(true);

    db.close();
  });
});
