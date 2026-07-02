import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, insertFile } from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../../server/http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient } from '../src/index.ts';

// F2b (#56) fetchFile — downloads bytes over HTTP with the agent token against
// the node-scoped GET /files/:id (F3 #57). Pure HTTP (no WS): exercises the
// httpUrl config (admin port ≠ ws port) + node-scoping. The file is seeded
// directly (server db API) — fetchFile is independent of how a file was sent.
describe('MeshClient.fetchFile (#56 F2b, over F3)', () => {
  let db: Database;
  let httpHandle: HttpAdminHandle;
  let httpUrl: string;
  let filesDir: string;
  const ADMIN = 'admin-secret';
  const clients: MeshClient[] = [];
  let tokenA: string, tokenB: string, tokenC: string;
  const FILE_ID = 'file-ab-1';
  const BYTES = new TextEncoder().encode('the payload bytes A→B');

  // fetchFile is pure HTTP; serverUrl is required by resolveConfig but unused here.
  function newClient(agentId: string, token: string): MeshClient {
    const c = new MeshClient({ serverUrl: 'ws://127.0.0.1:1', agentId, agentToken: token, httpUrl });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-fetchfile-test-'));
    tokenA = generateToken(); tokenB = generateToken(); tokenC = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    registerAgent(db, { id: 'C', token_hash: hashToken(tokenC), hostname: 'hC' });

    const filePath = join(filesDir, FILE_ID);
    await Bun.write(filePath, BYTES);
    insertFile(db, {
      id: FILE_ID, from_agent: 'A', to_agent: 'B', filename: 'doc.bin',
      content_type: 'application/octet-stream', size_bytes: BYTES.byteLength,
      file_path: filePath, sent_at: Date.now(), expires_at: null,
    });

    httpHandle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    httpUrl = `http://127.0.0.1:${(httpHandle.server.address() as net.AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await httpHandle.shutdown().catch(() => {});
    db.close();
  });

  it('recipient fetches the exact bytes (via httpUrl config)', async () => {
    const b = newClient('B', tokenB);
    expect(await b.fetchFile(FILE_ID)).toEqual(BYTES);
  });

  it('sender may also fetch the bytes', async () => {
    const a = newClient('A', tokenA);
    expect(await a.fetchFile(FILE_ID)).toEqual(BYTES);
  });

  it('an unrelated node is rejected (HTTP 404, no bytes, err.code=HTTP_404)', async () => {
    const c = newClient('C', tokenC);
    let err: any;
    await c.fetchFile(FILE_ID).catch((e) => { err = e; });
    expect(err).toBeDefined();
    expect(err.status).toBe(404);
    expect(err.code).toBe('HTTP_404');
  });

  it('unknown file id → HTTP 404 (indistinguishable from not-a-party)', async () => {
    const b = newClient('B', tokenB);
    let err: any;
    await b.fetchFile('no-such-file').catch((e) => { err = e; });
    expect(err?.status).toBe(404);
  });

  it('rejects when serverUrl/token are missing (resolveConfig)', async () => {
    const bad = new MeshClient({ httpUrl });
    await expect(bad.fetchFile(FILE_ID)).rejects.toThrow();
  });
});
