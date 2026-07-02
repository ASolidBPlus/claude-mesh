import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, insertFile } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #57 (F3) — node-scoped GET /files/:id. SECURITY: an agent may fetch a file
// only if it is the file's sender or recipient; deny-by-default returns the
// SAME 404 as not-found (no existence oracle). Admin retains full access.
// Invariant under test: widening to agentOrAdmin touches ONLY /files/:id (and
// the pre-existing /messages) — every other admin route still rejects agent tokens.
describe('GET /files/:id — node-scoped (#57)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';
  const TOK_A = 'tok-a';
  const TOK_B = 'tok-b';
  const TOK_C = 'tok-c';
  let filesDir: string;
  const FILE_ID = 'file-ab-1';
  const BYTES = new TextEncoder().encode('secret file bytes A→B');

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-files-scope-'));
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;

    registerAgent(db, { id: 'A', token_hash: hashToken(TOK_A), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(TOK_B), hostname: 'hB' });
    registerAgent(db, { id: 'C', token_hash: hashToken(TOK_C), hostname: 'hC' });

    // A file sent A→B, bytes on disk.
    const filePath = join(filesDir, FILE_ID);
    await Bun.write(filePath, BYTES);
    insertFile(db, {
      id: FILE_ID, from_agent: 'A', to_agent: 'B', filename: 'secret.txt',
      content_type: 'text/plain', size_bytes: BYTES.byteLength, file_path: filePath,
      sent_at: Date.now(), expires_at: null,
    });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const get = (path: string, token?: string) =>
    fetch(`${base}${path}`, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);

  it('recipient (to) may fetch the bytes', async () => {
    const res = await get(`/files/${FILE_ID}`, TOK_B);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('sender (from) may fetch the bytes', async () => {
    const res = await get(`/files/${FILE_ID}`, TOK_A);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('admin may fetch any file', async () => {
    const res = await get(`/files/${FILE_ID}`, ADMIN);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('an unrelated agent gets 404 — and it is INDISTINGUISHABLE from a missing file (no existence oracle)', async () => {
    const unrelated = await get(`/files/${FILE_ID}`, TOK_C);
    const missing = await get('/files/does-not-exist', TOK_C);
    expect(unrelated.status).toBe(404);
    expect(missing.status).toBe(404);
    // identical status, headers AND body → C cannot tell "not yours" from
    // "no such file" on any axis.
    expect(unrelated.headers.get('content-type')).toBe(missing.headers.get('content-type'));
    expect(await unrelated.json()).toEqual(await missing.json());
  });

  it('C cannot fetch an A↔B file (enumeration guard)', async () => {
    expect((await get(`/files/${FILE_ID}`, TOK_C)).status).toBe(404);
  });

  it('no token → 401; bad token → 401', async () => {
    expect((await get(`/files/${FILE_ID}`)).status).toBe(401);
    expect((await get(`/files/${FILE_ID}`, 'garbage-token')).status).toBe(401);
  });

  it('INVARIANT: widening is scoped — other admin routes still reject an agent token (401)', async () => {
    // C holds a valid agent token, but these are admin-only routes.
    expect((await get('/agents', TOK_C)).status).toBe(401);
    expect((await get('/agents/A', TOK_C)).status).toBe(401);
    expect((await get('/acl?agent=A', TOK_C)).status).toBe(401);
    expect((await get('/observers', TOK_C)).status).toBe(401);
    expect((await get('/topics', TOK_C)).status).toBe(401);
    expect((await get('/reminders', TOK_C)).status).toBe(401);
    // POST /files stays admin-only too — agent token must NOT be able to ingest.
    const postFiles = await fetch(`${base}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK_C}` },
    });
    expect(postFiles.status).toBe(401);
  });
});
