import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as net from 'net';
import * as tls from 'tls';
import { randomBytes } from 'crypto';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, aclGrant, getAgentById } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { loadTls, type ServerTls } from '../tls-config.ts';

// R-69 — Bun's `ws` IGNORES maxPayload (measured: its shim stores the option
// and never passes it to the native layer, whose own cap is 16 MiB per
// message). So the size of a frame has to be checked in the message handler,
// BEFORE JSON.parse; and because Bun still buffers up to 16 MiB per socket,
// the number of unauthenticated sockets is capped too.
//
// Every test drives a RAW client (TCP or TLS) with hand-built frames, so
// nothing on the client side limits or reshapes what reaches the server.

const dir = mkdtempSync(join(tmpdir(), 'mesh-r69-'));
const f = (n: string) => join(dir, n);
let TLS: ServerTls;
beforeAll(() => {
  const run = (...a: string[]) => { const r = Bun.spawnSync(['openssl', ...a], { cwd: dir, stderr: 'pipe' }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=ca');
  run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'bus.key', '-out', 'bus.csr', '-subj', '/CN=bus');
  writeFileSync(f('bus.ext'), 'subjectAltName=IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'bus.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'bus.pem', '-days', '2', '-extfile', 'bus.ext');
  const t = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key') });
  if (!t.ok || t.server === null) throw new Error('fixture TLS did not load');
  TLS = t.server;
});

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
// Below the ephemeral port range (32768+): a random listen port in it can
// collide with an outgoing connection's source port (CI flake, R-69).
const ports = () => { const b = 18000 + Math.floor(Math.random() * 1900); return [b, b + 1] as const; };

/** One masked text frame, zero mask key (legal, and masking is the identity). */
function frame(payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len])
    : len < 65536 ? Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, Buffer.alloc(4), payload]);
}

interface Raw { texts: string[]; close: () => { code: number } | null; upgraded: () => boolean; refusedHttp: () => string | null; send: (o: unknown) => void; sendRaw: (b: Buffer) => void; end: () => void }

/** A raw WebSocket client over TCP (or TLS), from an optional local address. */
async function raw(port: number, opt: { tls?: boolean; from?: string } = {}): Promise<Raw> {
  const sock: net.Socket = opt.tls
    ? tls.connect({ host: '127.0.0.1', port, ca: readFileSync(f('ca.pem'), 'utf8') })
    : net.connect({ host: '127.0.0.1', port, ...(opt.from ? { localAddress: opt.from } : {}) });
  await new Promise<void>((r, j) => { sock.once(opt.tls ? 'secureConnect' : 'connect', () => r()); sock.once('error', j); });
  sock.on('error', () => { /* a refused or terminated socket */ });
  let buf = Buffer.alloc(0); let up = false; let http: string | null = null;
  const texts: string[] = []; let closed: { code: number } | null = null;
  sock.on('close', () => { closed ??= { code: 1006 }; });
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    if (!up) {
      const i = buf.indexOf('\r\n\r\n'); if (i === -1) return;
      const status = buf.subarray(0, buf.indexOf('\r\n')).toString();
      if (!status.includes(' 101 ')) { http = status; return; }
      up = true; buf = buf.subarray(i + 4);
    }
    while (buf.length >= 2) {
      let len = buf[1]! & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const op = buf[0]! & 0x0f; const body = buf.subarray(off, off + len);
      if (op === 1) texts.push(body.toString());
      if (op === 8) closed = { code: body.length >= 2 ? body.readUInt16BE(0) : 1005 };
      buf = buf.subarray(off + len);
    }
  });
  sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await wait(150);
  return {
    texts, close: () => closed, upgraded: () => up, refusedHttp: () => http,
    send: (o) => { try { sock.write(frame(Buffer.from(JSON.stringify(o)))); } catch { /* gone */ } },
    sendRaw: (b) => { try { sock.write(frame(b)); } catch { /* gone */ } },
    end: () => sock.destroy(),
  };
}

let db: Database | undefined;
const handles: WsServerHandle[] = [];
const raws: Raw[] = [];
const realLog = console.log;
afterEach(async () => {
  console.log = realLog;
  for (const r of raws.splice(0)) r.end();
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {});
  db?.close(); db = undefined;
});

async function bus(opts: { maxFileBytes?: number; preAuth?: { global: number; perIp: number } } = {}): Promise<{ p: number; t: number; lines: string[] }> {
  db = openDb(':memory:');
  for (const id of ['alice', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  aclGrant(db, 'alice', 'bob', 'admin');
  const [p, t] = ports();
  const lines: string[] = [];
  // Captured for the WHOLE test (restored in afterEach): the guard's log
  // lines are part of what is asserted.
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  const h = await startWsServer(p, db, opts.maxFileBytes ?? 10_485_760, mkdtempSync(join(tmpdir(), 'r69-f-')), 0, new Map(), TLS,
    { tlsPort: t, ...(opts.preAuth ? { preAuth: opts.preAuth } : {}) });
  handles.push(h);
  return { p, t, lines };
}
const evts = (lines: string[], evt: string) => lines.flatMap(l => { try { const o = JSON.parse(l); return o?.evt === evt ? [o] : []; } catch { return []; } });

describe('pre-auth: an over-limit FIRST frame closes the socket without being parsed', () => {
  for (const viaTls of [false, true]) {
    it(`a valid auth frame padded past the pre-auth limit is NOT honoured (${viaTls ? 'TLS' : 'plaintext'} listener)`, async () => {
      // On main this frame is parsed, IS a valid auth frame, and authenticates:
      // auth_ok. The padding is a field the auth path ignores.
      const { p, t } = await bus();
      const c = await raw(viaTls ? t : p, { tls: viaTls }); raws.push(c);
      expect(c.upgraded()).toBe(true);
      c.send({ type: 'auth', agent_id: 'alice', token: 'alice-tok', pad: 'x'.repeat(2 * 1024 * 1024) });
      await wait(400);
      expect(c.texts).toEqual([]);                 // no auth_ok, no error frame: nothing parsed
      expect(c.close()?.code).toBe(1009);          // "message too big"
      expect(getAgentById(db!, 'alice')!.online).toBe(0);
    });
  }

  it('an ordinary auth frame is unaffected (positive control)', async () => {
    const { p } = await bus();
    const c = await raw(p); raws.push(c);
    c.send({ type: 'auth', agent_id: 'alice', token: 'alice-tok' });
    await wait(200);
    expect(JSON.parse(c.texts[0]!).type).toBe('auth_ok');
  });
});

describe('post-auth: an over-limit frame closes the socket without being parsed', () => {
  it('above the post-auth limit → close 1009, no reply; under it → served as before', async () => {
    // maxFileBytes 256 KiB → the post-auth limit is its floor, 1.1 MB.
    const { p, lines } = await bus({ maxFileBytes: 256 * 1024 });
    const c = await raw(p); raws.push(c);
    c.send({ type: 'auth', agent_id: 'alice', token: 'alice-tok' });
    await wait(200);
    c.send({ type: 'send', msg_id: 'small', to: 'bob', payload: 'hi', content_type: 'text/plain' });
    await wait(150);
    expect(c.texts.some(x => x.includes('"ref":"small"') && x.includes('"ok":true'))).toBe(true);   // control

    // On main: parsed, MESSAGE_TOO_LARGE, and the socket stays open.
    c.send({ type: 'send', msg_id: 'big', to: 'bob', payload: 'x'.repeat(2 * 1024 * 1024), content_type: 'text/plain' });
    await wait(400);
    expect(c.texts.some(x => x.includes('"ref":"big"'))).toBe(false);
    expect(c.close()?.code).toBe(1009);
    expect(evts(lines, 'ws.frame_too_large')).toMatchObject([{ authed: true, limit: 1_100_000, src_ip: '127.0.0.1', tls: false }]);
  });

  it('a file_send at the configured maxFileBytes still fits (the limit follows the file cap)', async () => {
    const max = 2 * 1024 * 1024;
    const { p } = await bus({ maxFileBytes: max });
    const c = await raw(p); raws.push(c);
    c.send({ type: 'auth', agent_id: 'alice', token: 'alice-tok' });
    await wait(200);
    c.send({ type: 'file_send', msg_id: 'f1', to: 'bob', filename: 'blob.bin', data: randomBytes(max).toString('base64') });
    await wait(600);
    expect(c.close()).toBeNull();
    expect(c.texts.some(x => x.includes('"ref":"f1"') && x.includes('"ok":true'))).toBe(true);
  });
});

describe('the number of UNAUTHENTICATED sockets is capped — per source address and globally', () => {
  it('per-IP cap: the next pre-auth socket from that address is refused; another address is not; an auth frees the slot', async () => {
    const { p, lines } = await bus({ preAuth: { global: 10, perIp: 2 } });
    const a1 = await raw(p, { from: '127.0.0.1' }); const a2 = await raw(p, { from: '127.0.0.1' }); raws.push(a1, a2);
    const a3 = await raw(p, { from: '127.0.0.1' }); raws.push(a3);
    expect([a1.upgraded(), a2.upgraded(), a3.upgraded()]).toEqual([true, true, false]);
    expect(a3.refusedHttp()).toContain('503');
    const a3b = await raw(p, { from: '127.0.0.1' }); raws.push(a3b);   // a SECOND refusal, inside the log interval
    expect(a3b.upgraded()).toBe(false);
    const b1 = await raw(p, { from: '127.0.0.2' }); raws.push(b1);
    expect(b1.upgraded()).toBe(true);
    a1.send({ type: 'auth', agent_id: 'alice', token: 'alice-tok' });
    await wait(200);
    const a4 = await raw(p, { from: '127.0.0.1' }); raws.push(a4);
    expect(a4.upgraded()).toBe(true);             // alice authenticated: her slot is free
    const refused = evts(lines, 'ws.preauth_refused');
    expect(refused.length).toBe(1);               // two refusals, ONE line: once per interval, not per socket
    expect(refused[0]).toMatchObject({ scope: 'per_ip', src_ip: '127.0.0.1' });
  });

  it('an ABORTED handshake does not leak its slot (no WebSocket ever exists for it)', async () => {
    const { p } = await bus({ preAuth: { global: 10, perIp: 1 } });
    // An upgrade the ws layer rejects (bad key): the server answers 400 and
    // destroys the socket without ever creating a WebSocket.
    const bad = net.connect(p, '127.0.0.1'); bad.on('error', () => {});
    await new Promise<void>(r => bad.once('connect', () => r()));
    const answer = await new Promise<string>(r => { bad.on('data', d => r(d.toString())); bad.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: not-a-key\r\nSec-WebSocket-Version: 13\r\n\r\n'); setTimeout(() => r('none'), 1000); });
    expect(answer).toContain('400');
    await wait(200);
    // perIp is 1: if the aborted attempt still held its slot, this is refused.
    const ok = await raw(p, { from: '127.0.0.1' }); raws.push(ok);
    expect(ok.upgraded()).toBe(true);
  });

  it('global cap: refused across addresses once the total is reached; a closed socket frees its slot', async () => {
    const { p } = await bus({ preAuth: { global: 2, perIp: 10 } });
    const c1 = await raw(p, { from: '127.0.0.2' }); const c2 = await raw(p, { from: '127.0.0.3' }); raws.push(c1, c2);
    const c3 = await raw(p, { from: '127.0.0.4' }); raws.push(c3);
    expect([c1.upgraded(), c2.upgraded(), c3.upgraded()]).toEqual([true, true, false]);
    c1.end();
    await wait(200);
    const c4 = await raw(p, { from: '127.0.0.4' }); raws.push(c4);
    expect(c4.upgraded()).toBe(true);
  });
});
