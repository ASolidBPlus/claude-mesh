import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, insertFile } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle, ROUTES, contentDispositionFor, safeContentType } from '../http-admin.ts';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// 2026-08-01 incident: a stored filename with an em-dash (U+2014) made
// writeHead throw ERR_INVALID_CHAR and KILLED THE SERVER PROCESS — a
// whole-mesh DoS from one unicode filename, invisible to container health
// (sleep-style PID 1 stays "Up"), and a crash LOOP because the recipient's
// inbox auto-refetch re-triggered it on every restart.
//
// These tests run at the layer the bug lived: a real server, a real GET, the
// incident's actual filename. Pre-fix, the first fetch here killed the test
// process itself — this file could not have passed by accident.

const POISON = '2026-08-01 — Independent parties, one hop.md'; // the real row

describe('GET /files/:id — header injection cannot kill the server', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  const ADMIN = 'admin-secret';
  const TOK_B = 'tok-b';
  let filesDir: string;
  const BYTES = new TextEncoder().encode('file body bytes');

  const addFile = async (id: string, filename: string, content_type: string) => {
    const filePath = join(filesDir, id);
    await Bun.write(filePath, BYTES);
    insertFile(db, {
      id, from_agent: 'A', to_agent: 'B', filename, content_type,
      size_bytes: BYTES.byteLength, file_path: filePath,
      sent_at: Date.now(), expires_at: null,
    });
  };

  const get = (path: string, token: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-hdr-dos-'));
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
    registerAgent(db, { id: 'A', token_hash: hashToken('tok-a'), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(TOK_B), hostname: 'hB' });
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it("serves the incident's exact poison filename — 200, bytes intact, both header forms", async () => {
    await addFile('f-poison', POISON, 'text/markdown');
    const res = await get('/files/f-poison', TOK_B);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    const cd = res.headers.get('content-disposition')!;
    // ASCII fallback carries no byte writeHead rejects; the em-dash is gone.
    expect(cd).toContain('filename="2026-08-01 _ Independent parties, one hop.md"');
    // The starred form round-trips the real name for RFC 5987 clients.
    expect(cd).toContain("filename*=UTF-8''2026-08-01%20%E2%80%94%20Independent");
  });

  it('the crash-loop shape: the SAME file fetches twice and the server answers after', async () => {
    // The incident was a loop because restart → inbox auto-refetch → crash.
    // Post-fix the refetch is just a second 200 — and a THIRD request to a
    // different route proves the process is still up, which is the actual
    // property (a dead server fails this file at the transport layer anyway).
    await addFile('f-loop', POISON, 'text/markdown');
    expect((await get('/files/f-loop', TOK_B)).status).toBe(200);
    expect((await get('/files/f-loop', TOK_B)).status).toBe(200);
    const alive = await fetch(`${base}/metrics`);
    expect(alive.status).toBe(200);
  });

  it('a poisoned content_type is the same vector one line up — served as octet-stream', async () => {
    await addFile('f-ct', 'fine.txt', 'text/markdown; título=—');
    const res = await get('/files/f-ct', TOK_B);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('quotes, backslashes, newlines and emoji in filenames all serve 200', async () => {
    const nasty = ['a"b\\c.txt', 'line\r\nbreak.txt', '🦆 report.pdf', 'café.md'];
    for (let i = 0; i < nasty.length; i++) {
      await addFile(`f-n${i}`, nasty[i], 'application/octet-stream');
      const res = await get(`/files/f-n${i}`, TOK_B);
      expect(res.status).toBe(200);
      // And the fallback half of the header never contains a quote-breaker.
      const ascii = /filename="([^"]*)"/.exec(res.headers.get('content-disposition')!)![1];
      expect(ascii).not.toMatch(/["\\\r\n]/);
    }
  });
});

describe('dispatcher guard — a handler throw is a 500, not a dead mesh', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, 'admin-secret', 1024, mkdtempSync(join(tmpdir(), 'mesh-guard-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });

  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('an injected throwing route returns 500 and the server survives', async () => {
    // The header bug was one INSTANCE; the class is "any handler throw kills
    // the process" (async createServer callback, previously no catch). The
    // guard is the class fix, so it gets its own proof rather than resting on
    // a read of the dispatcher.
    const route = {
      method: 'GET',
      auth: 'admin' as const,
      match: (p: string) => (p === '/__test_throw' ? {} : null),
      handler: async () => { throw new Error('deliberate test explosion'); },
    };
    ROUTES.push(route as never);
    try {
      const res = await fetch(`${base}/__test_throw`, { headers: { Authorization: 'Bearer admin-secret' } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal error' });
      // The process is alive: an unrelated route still answers.
      expect((await fetch(`${base}/metrics`)).status).toBe(200);
    } finally {
      ROUTES.splice(ROUTES.indexOf(route as never), 1);
    }
  });
});

describe('the pure sanitisers', () => {
  it('contentDispositionFor: latin1-clean fallback, RFC 5987 starred form', () => {
    const cd = contentDispositionFor(POISON);
    for (const ch of /filename="([^"]*)"/.exec(cd)![1]) {
      const code = ch.charCodeAt(0);
      expect(code).toBeGreaterThanOrEqual(0x20);
      expect(code).toBeLessThanOrEqual(0x7e);
    }
    // The four chars encodeURIComponent leaves bare but RFC 5987 forbids.
    const starred = contentDispositionFor("a'b(c)d*e.txt");
    expect(starred).toContain("filename*=UTF-8''a%27b%28c%29d%2Ae.txt");
  });

  it('safeContentType: passes well-formed types, replaces anything else', () => {
    expect(safeContentType('text/plain')).toBe('text/plain');
    expect(safeContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(safeContentType('text/—')).toBe('application/octet-stream');
    expect(safeContentType('nonsense')).toBe('application/octet-stream');
    expect(safeContentType(null)).toBe('application/octet-stream');
    expect(safeContentType('a/b; x=\r\ninjected')).toBe('application/octet-stream');
  });
});
