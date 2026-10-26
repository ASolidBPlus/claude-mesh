// R-406 — log in with a standard OAuth access token (RFC 9068 JWT), off unless
// configured. The guards pinned here, each with a mutant in the PR:
//   wrong iss / aud, expired, wrong typ, alg:none, HS256 signed with the public
//   key, an unknown kid, an identity with `+` or `:`, an alias under another
//   identity, MESH_STATIC_TOKENS=off on WS and on /files, unset config refusing
//   JWTs, a session closed at exp, and re-auth that must not move the deadline
//   for a different identity / alias, an earlier or equal exp, or a bad
//   signature.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { openDb, registerAgent, aclGrant, insertMessage, getAgentById, setOidcSub } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { routeFile } from '../router.ts';
import { createOidcVerifier, parseTokenAuthConfig, type OidcConfig, type OidcVerifier } from '../oidc.ts';
import type { TokenAuth } from '../token-auth.ts';
import { accessToken, makeCa, makeKey, rawJws, startIssuer, type TestIssuer, type TestKey } from './helpers/test-issuer.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 23800;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const AUD = 'mesh';

const dir = tmp('r406-');
let ca: ReturnType<typeof makeCa>;
let otherCa: ReturnType<typeof makeCa>;
let key: TestKey;
let rotated: TestKey;
beforeAll(async () => {
  ca = makeCa(dir, 'ca');
  otherCa = makeCa(dir, 'other');
  key = await makeKey('k1', 'ES256');
  rotated = await makeKey('k2', 'RS256');
});

let issuer: TestIssuer | undefined;
const verifiers: OidcVerifier[] = [];
afterEach(() => { issuer?.stop(); issuer = undefined; for (const v of verifiers.splice(0)) v.stop(); });

const cfg = (iss: string, over: Partial<OidcConfig> = {}): OidcConfig => ({ issuer: iss, audience: AUD, idClaim: 'preferred_username', caFile: ca.caFile, jwksFile: null, ...over });
async function readyVerifier(c: OidcConfig, deps: Parameters<typeof createOidcVerifier>[1] = {}): Promise<OidcVerifier> {
  const v = createOidcVerifier(c, { log: () => {}, ...deps });
  verifiers.push(v);
  for (let i = 0; i < 50 && !v.ready(); i++) await delay(20);
  return v;
}
// An agent's own token: client_id is its identity (W-1514 M9).
const good = (claims: Record<string, unknown> = {}, opts: Parameters<typeof accessToken>[2] = {}) =>
  accessToken(key, { iss: issuer!.url, aud: AUD, preferred_username: 'fred', sub: 'u-1', client_id: 'preferred_username' in claims ? claims.preferred_username : 'fred', ...claims }, opts);

describe('R-406 configuration', () => {
  it('unset is today; whole configs load; half or unreadable config refuses', () => {
    expect(parseTokenAuthConfig({})).toEqual({ ok: true, config: { oidc: null, staticTokens: true, adminStaticToken: true, metricsStaticToken: true } });
    const jwksFile = join(dir, 'jwks.json');
    writeFileSync(jwksFile, JSON.stringify({ keys: [] }));
    expect(parseTokenAuthConfig({ MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh', MESH_OIDC_CA_FILE: ca.caFile, MESH_STATIC_TOKENS: 'off', MESH_ADMIN_STATIC_TOKEN: 'on', MESH_METRICS_STATIC_TOKEN: 'on' }))
      .toEqual({ ok: true, config: { oidc: { issuer: 'https://id.example', audience: 'mesh', idClaim: 'preferred_username', caFile: ca.caFile, jwksFile: null, adminAudience: null }, staticTokens: false, adminStaticToken: true, metricsStaticToken: true } });
    expect(parseTokenAuthConfig({ MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh', MESH_OIDC_JWKS_FILE: jwksFile, MESH_OIDC_ID_CLAIM: 'sub', MESH_STATIC_TOKENS: 'on', MESH_ADMIN_STATIC_TOKEN: 'on', MESH_METRICS_STATIC_TOKEN: 'on' }))
      .toEqual({ ok: true, config: { oidc: { issuer: 'https://id.example', audience: 'mesh', idClaim: 'sub', caFile: null, jwksFile, adminAudience: null }, staticTokens: true, adminStaticToken: true, metricsStaticToken: true } });
    const badJwks = join(dir, 'bad.json');
    writeFileSync(badJwks, '{"nope":1}');
    for (const bad of [
      { MESH_OIDC_AUDIENCE: 'mesh' }, { MESH_OIDC_CA_FILE: ca.caFile },
      { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_CA_FILE: ca.caFile },
      { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh' },
      { MESH_OIDC_ISSUER: 'http://id.example', MESH_OIDC_AUDIENCE: 'mesh', MESH_OIDC_CA_FILE: ca.caFile },
      { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh', MESH_OIDC_CA_FILE: '/no/such.pem' },
      { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh', MESH_OIDC_JWKS_FILE: badJwks },
      { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh', MESH_OIDC_CA_FILE: ca.caFile, MESH_OIDC_ID_CLAIM: 'email' },
      { MESH_STATIC_TOKENS: 'off' }, { MESH_STATIC_TOKENS: 'no' },
    ]) expect({ bad, ok: parseTokenAuthConfig(bad).ok }).toEqual({ bad, ok: false });
  });
});

describe('R-406 the verifier', () => {
  beforeEach(() => { issuer = startIssuer(nextPort(), ca, [key]); });

  it('a good token gives its identity and exp', async () => {
    const v = await readyVerifier(cfg(issuer!.url));
    const r = await v.verify(await good());
    expect(r).toMatchObject({ ok: true, identity: 'fred' });
    expect(await (await readyVerifier(cfg(issuer!.url, { idClaim: 'sub' }))).verify(await good({ sub: 'u-1', client_id: 'u-1' }))).toMatchObject({ ok: true, identity: 'u-1' });
  });

  it('GUARDS: each wrong token is refused with its own reason', async () => {
    const v = await readyVerifier(cfg(issuer!.url));
    const now = Math.floor(Date.now() / 1000);
    const pub = JSON.stringify(key.jwk);
    const hsSig = (h: Record<string, unknown>, p: Record<string, unknown>) => {
      const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return createHmac('sha256', pub).update(`${b(h)}.${b(p)}`).digest('base64url');
    };
    const claims = { iss: issuer!.url, aud: AUD, preferred_username: 'fred', exp: now + 300 };
    const cases: [string, string][] = [
      [await good({ iss: 'https://evil.example' }), 'WRONG_ISSUER'],
      [await good({ aud: 'not-mesh' }), 'WRONG_AUDIENCE'],
      [await good({}, { expIn: -120 }), 'EXPIRED'],
      [await good({}, { nbfIn: 600 }), 'NOT_YET_VALID'],
      [await good({}, { typ: 'JWT' }), 'WRONG_TYP'],
      [rawJws({ alg: 'none', typ: 'at+jwt', kid: 'k1' }, claims, ''), 'BAD_ALG'],
      [rawJws({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' }, claims, hsSig({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' }, claims)), 'BAD_ALG'],
      [await good({}, { kid: null }), 'NO_KID'],
      [await accessToken(rotated, { ...claims }), 'UNKNOWN_KID'],
      [await good({ preferred_username: 'fred+x' }), 'BAD_IDENTITY'],
      [await good({ preferred_username: 'pod1:fred' }), 'BAD_IDENTITY'],
      [await good({ preferred_username: undefined }), 'NO_IDENTITY'],
      [(await good()).slice(0, -4) + 'AAAA', 'BAD_SIGNATURE'],
    ];
    for (const [token, reason] of cases) expect({ reason, got: await v.verify(token) }).toMatchObject({ reason, got: { ok: false, reason } });
  });

  it('a rotated key is fetched on an unknown kid, at most once a minute', async () => {
    let clock = Date.now();
    const v = await readyVerifier(cfg(issuer!.url), { now: () => clock });
    const before = issuer!.jwksFetches();
    clock += 61_000;
    issuer!.setKeys([key, rotated]);
    const t = await accessToken(rotated, { iss: issuer!.url, aud: AUD, preferred_username: 'fred', sub: 'u-fred', client_id: 'fred' });
    expect(await v.verify(t)).toMatchObject({ ok: true, identity: 'fred' });
    expect(issuer!.jwksFetches()).toBe(before + 1);
    // A second unknown kid within the minute does not fetch again.
    const stranger = await makeKey('k3');
    expect(await v.verify(await accessToken(stranger, { iss: issuer!.url, aud: AUD, preferred_username: 'fred', sub: 'u-fred', client_id: 'fred' }))).toMatchObject({ ok: false, reason: 'UNKNOWN_KID' });
    expect(issuer!.jwksFetches()).toBe(before + 1);
  });

  it('discovery only over the pinned CA, and only for the configured issuer', async () => {
    const wrongCa = await readyVerifier(cfg(issuer!.url, { caFile: otherCa.caFile }));
    expect(wrongCa.ready()).toBe(false);
    expect(await wrongCa.verify(await good())).toMatchObject({ ok: false, reason: 'OIDC_NOT_READY' });
    issuer!.stop();
    issuer = startIssuer(nextPort(), ca, [key], { issuerOverride: 'https://someone-else.example' });
    expect((await readyVerifier(cfg(issuer!.url))).ready()).toBe(false);
  });

  it('an issuer down at boot: refused until it comes up, then accepted, with no restart', async () => {
    const port = nextPort();
    const url = `https://127.0.0.1:${port}`;
    const v = createOidcVerifier(cfg(url), { log: () => {} });
    verifiers.push(v);
    await delay(200);
    expect(v.ready()).toBe(false);
    issuer = startIssuer(port, ca, [key]);
    for (let i = 0; i < 60 && !v.ready(); i++) await delay(100);
    expect(v.ready()).toBe(true);
    expect(await v.verify(await accessToken(key, { iss: url, aud: AUD, preferred_username: 'fred', sub: 'u-fred', client_id: 'fred' }))).toMatchObject({ ok: true });
  }, 15_000);

  it('standalone: a local JWKS file runs the same verifier, no discovery', async () => {
    const f = join(dir, 'local-jwks.json');
    writeFileSync(f, JSON.stringify({ keys: [key.jwk] }));
    const v = await readyVerifier({ issuer: 'https://mesh.local', audience: AUD, idClaim: 'preferred_username', caFile: null, jwksFile: f });
    expect(await v.verify(await accessToken(key, { iss: 'https://mesh.local', aud: AUD, preferred_username: 'solo', sub: 'u-solo', client_id: 'solo' }))).toMatchObject({ ok: true, identity: 'solo' });
    expect(await v.verify(await accessToken(key, { iss: 'https://mesh.local', aud: AUD, preferred_username: 'solo', sub: 'u-solo', client_id: 'solo' }, { typ: 'JWT' }))).toMatchObject({ ok: false, reason: 'WRONG_TYP' });
  });
});

type Frame = Record<string, unknown> & { type: string };

describe('R-406 on the wire', () => {
  let db: Database;
  let ws: WsServerHandle | undefined;
  let admin: HttpAdminHandle | undefined;
  let wsPort: number;
  let lines: string[];
  const realLog = console.log;
  const opened: WebSocket[] = [];

  async function up(auth: (v: OidcVerifier | null) => TokenAuth): Promise<void> {
    issuer = startIssuer(nextPort(), ca, [key]);
    const v = await readyVerifier(cfg(issuer.url));
    const tokenAuth = auth(v);
    wsPort = nextPort();
    ws = await startWsServer(wsPort, db, 10_485_760, tmp('r406-ws-'), 0, new Map(), null, { tokenAuth });
    admin = await startHttpAdmin(0, db, 'adm', 10_485_760, tmp('r406-adm-'), ws.agentIndex, ws.observerIndex, new Map(), {}, { tokenAuth });
  }
  async function login(auth: Record<string, unknown>, upgradeBearer?: string): Promise<{ sock: WebSocket; reply: Frame; frames: Frame[]; closed: Promise<{ code: number; reason: string }> }> {
    const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`, upgradeBearer === undefined ? {} : { headers: { Authorization: `Bearer ${upgradeBearer}` } });
    opened.push(sock);
    const closed = new Promise<{ code: number; reason: string }>(r => sock.once('close', (code, reason) => r({ code, reason: reason.toString() })));
    await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
    const frames: Frame[] = [];
    const reply = await new Promise<Frame>((resolve) => {
      let first = true;
      sock.on('message', (d) => { const f = JSON.parse(d.toString()) as Frame; if (first) { first = false; resolve(f); return; } frames.push(f); });
      sock.send(JSON.stringify({ type: 'auth', ...auth }));
    });
    return { sock, reply, frames, closed };
  }

  beforeEach(() => {
    db = openDb(':memory:');
    lines = [];
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    for (const id of ['fred', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
    // Rows that predate OIDC log in by it only once an admin binds them (W-1514 H3).
    for (const id of ['fred', 'bob']) setOidcSub(db, id, 'u-1');
  });
  afterEach(async () => {
    console.log = realLog;
    for (const s of opened.splice(0)) { try { s.close(); } catch { /* ignore */ } }
    await ws?.shutdown().catch(() => {});
    await admin?.shutdown().catch(() => {});
    ws = undefined; admin = undefined;
    db.close();
  });

  it('a JWT logs in (frame or upgrade header); a new identity is created on its first login; the token is never logged', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    const t = await good();
    const a = await login({ agent_id: 'fred', token: t });
    expect(a.reply).toMatchObject({ type: 'auth_ok', agent_id: 'fred', token_exp: expect.any(Number) });
    const nt = await good({ preferred_username: 'newcomer' });
    const b = await login({ agent_id: 'newcomer' }, nt);
    expect(b.reply).toMatchObject({ type: 'auth_ok', agent_id: 'newcomer' });
    expect(getAgentById(db, 'newcomer')?.hostname).toBe('claude-newcomer');
    expect(lines.join('\n')).not.toContain(t.split('.')[2]!);
    expect(lines.join('\n')).not.toContain(nt.split('.')[2]!);
  });

  it('GUARD: the frame\'s agent_id must be the token\'s identity; an alias only under it', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    const t = await good();
    expect((await login({ agent_id: 'bob', token: t })).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    expect((await login({ agent_id: 'fred', token: t, alias: 'x' })).reply).toMatchObject({ type: 'auth_ok', agent_id: 'fred+x' });
    expect((await login({ agent_id: 'bob', token: t, alias: 'x' })).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    expect(lines.some(l => l.includes('"refused":"oidc_identity_mismatch"'))).toBe(true);
  });

  it('GUARD: with OIDC unset, a JWT is refused (and static tokens work as today)', async () => {
    await up(() => ({ oidc: null, staticTokens: true }));
    expect((await login({ agent_id: 'fred', token: await good() })).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    expect((await login({ agent_id: 'fred', token: 'fred-tok' })).reply).toMatchObject({ type: 'auth_ok' });
  });

  it('GUARD: MESH_STATIC_TOKENS=off refuses a static token on WS, /files (agent port) and /messages (admin port); the admin token still works', async () => {
    await up((v) => ({ oidc: v, staticTokens: false }));
    expect((await login({ agent_id: 'fred', token: 'fred-tok' })).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    aclGrant(db, 'bob', 'fred', 'admin');
    const f = routeFile(db, new Map(), 'bob', { type: 'file_send', msg_id: 'f1', to: 'fred', filename: 'a.txt', data: Buffer.from('x').toString('base64') } as never, 10_485_760, tmp('r406-files-'));
    const fileUrl = `http://127.0.0.1:${wsPort}/files/${f.fileId}`;
    expect((await fetch(fileUrl, { headers: { Authorization: 'Bearer fred-tok' } })).status).toBe(401);
    expect((await fetch(fileUrl, { headers: { Authorization: `Bearer ${await good()}` } })).status).toBe(200);
    const adminBase = `http://127.0.0.1:${(admin!.server.address() as net.AddressInfo).port}`;
    insertMessage(db, { id: 'm', kind: 'direct', from_agent: 'bob', to_agent: 'fred', payload: 'p', sent_at: 1 });
    expect((await fetch(`${adminBase}/messages`, { headers: { Authorization: 'Bearer fred-tok' } })).status).toBe(401);
    expect((await fetch(`${adminBase}/messages`, { headers: { Authorization: `Bearer ${await good()}` } })).status).toBe(200);
    expect((await fetch(`${adminBase}/agents`, { headers: { Authorization: 'Bearer adm' } })).status).toBe(200);
  });

  it('frames sent right after the auth frame wait for the verdict and are then served in order', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    aclGrant(db, 'fred', 'bob', 'admin');
    const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    opened.push(sock);
    await new Promise<void>((r) => sock.once('open', () => r()));
    const got: Frame[] = [];
    sock.on('message', (d) => got.push(JSON.parse(d.toString())));
    sock.send(JSON.stringify({ type: 'auth', agent_id: 'fred', token: await good() }));
    sock.send(JSON.stringify({ type: 'send', msg_id: 'early', to: 'bob', payload: 'x' }));
    await delay(150);
    expect(got.map(f => f.type === 'ack' ? `ack:${f.ref}` : f.type)).toEqual(['auth_ok', 'ack:early']);
  });

  it('GUARD: a session is closed at its token\'s exp with TOKEN_EXPIRED', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    const s = await login({ agent_id: 'fred', token: await good({}, { expIn: 2 }) });
    expect(s.reply.type).toBe('auth_ok');
    const c = await Promise.race([s.closed, delay(5000).then(() => null)]);
    expect(c).toEqual({ code: 4001, reason: 'TOKEN_EXPIRED' });
    expect(s.frames.some(f => f.code === 'TOKEN_EXPIRED')).toBe(true);
  }, 10_000);

  it('re-auth with a later token moves the deadline; every bad re-auth is refused and leaves the old deadline', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    const s = await login({ agent_id: 'fred', token: await good({}, { expIn: 3 }), alias: 'x' });
    expect(s.reply).toMatchObject({ type: 'auth_ok', agent_id: 'fred+x' });
    const reauth = (ref: string, f: Record<string, unknown>) => s.sock.send(JSON.stringify({ type: 'auth', msg_id: ref, ...f }));
    const forged = (await good({}, { expIn: 600 })).slice(0, -4) + 'AAAA';
    reauth('id', { agent_id: 'bob', token: await good({ preferred_username: 'bob' }, { expIn: 600 }), alias: 'x' });
    reauth('named', { agent_id: 'bob', token: await good({}, { expIn: 600 }), alias: 'x' });
    reauth('alias', { agent_id: 'fred', token: await good({}, { expIn: 600 }), alias: 'y' });
    reauth('noalias', { agent_id: 'fred', token: await good({}, { expIn: 600 }) });
    reauth('earlier', { agent_id: 'fred', token: await good({}, { expIn: 1 }), alias: 'x' });
    reauth('sig', { agent_id: 'fred', token: forged, alias: 'x' });
    await delay(200);
    const refused = s.frames.filter(f => f.code === 'REAUTH_REFUSED').map(f => f.ref).sort();
    expect(refused).toEqual(['alias', 'earlier', 'id', 'named', 'noalias', 'sig']);
    // The old 3 s deadline still holds: the socket closes on it.
    const c = await Promise.race([s.closed, delay(6000).then(() => null)]);
    expect(c).toEqual({ code: 4001, reason: 'TOKEN_EXPIRED' });
  }, 12_000);

  it('a good re-auth keeps the session past the old deadline', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    const s = await login({ agent_id: 'fred', token: await good({}, { expIn: 2 }) });
    s.sock.send(JSON.stringify({ type: 'auth', msg_id: 'r1', agent_id: 'fred', token: await good({}, { expIn: 600 }) }));
    await delay(150);
    expect(s.frames.find(f => f.ref === 'r1')).toMatchObject({ type: 'ack', ok: true, token_exp: expect.any(Number) });
    await delay(2600);
    expect(s.sock.readyState).toBe(WebSocket.OPEN);
    // ...and it is the same session: no displacement, presence untouched.
    expect(s.frames.some(f => f.code === 'DISPLACED')).toBe(false);
  }, 10_000);

  it('re-auth on a static-token session is refused, and changes nothing', async () => {
    await up((v) => ({ oidc: v, staticTokens: true }));
    const s = await login({ agent_id: 'fred', token: 'fred-tok' });
    s.sock.send(JSON.stringify({ type: 'auth', msg_id: 'r', agent_id: 'fred', token: await good() }));
    await delay(150);
    expect(s.frames.find(f => f.ref === 'r')).toMatchObject({ type: 'error', code: 'REAUTH_REFUSED' });
    expect(s.sock.readyState).toBe(WebSocket.OPEN);
  });
});
