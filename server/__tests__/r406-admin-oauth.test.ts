// R-406, the admin half — the admin API and /metrics take an OAuth access
// token from the same issuer for a second audience (MESH_OIDC_ADMIN_AUDIENCE),
// scope-checked per route; the static admin and metrics tokens can each be
// switched off; and an agent's name is bound to the `sub` of its first OIDC
// login. The guards pinned here, each with a mutant in the PR:
//   an agent-audience token refused on the admin API; a scope checked per
//   route (mesh:agents:read/write, mesh:acl, mesh:reminders, …, mesh:metrics
//   on /metrics);
//   no catch-all scope; an empty or missing scope granting nothing; an
//   unmapped route refused; MESH_ADMIN_STATIC_TOKEN=off refusing the admin
//   token and _PREV everywhere; MESH_METRICS_STATIC_TOKEN=off refusing the
//   metrics token and never leaving /metrics open; the caller's `sub` in the
//   logs; a different `sub` for a bound name refused on login and re-auth;
//   an unbound existing row refused (W-1514 H3) until an admin binds it; a
//   new name created and bound; a static login not touching the binding.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import * as net from 'net';
import { join } from 'path';
import { openDb, registerAgent, getAgentById, setOidcSub, oidcSubState, grantObserver } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';
import { createOidcVerifier, parseTokenAuthConfig, scopesOf, type OidcConfig, type OidcVerifier } from '../oidc.ts';
import { accessToken, makeCa, makeKey, startIssuer, type TestIssuer, type TestKey } from './helpers/test-issuer.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

let portCounter = 24000;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const AUD = 'mesh';
const ADMIN_AUD = 'mesh-admin';

const dir = tmp('r406a-');
let ca: ReturnType<typeof makeCa>;
let key: TestKey;
beforeAll(async () => {
  ca = makeCa(dir, 'ca');
  key = await makeKey('k1', 'ES256');
});

let issuer: TestIssuer | undefined;
const verifiers: OidcVerifier[] = [];
afterEach(() => { issuer?.stop(); issuer = undefined; for (const v of verifiers.splice(0)) v.stop(); });

const cfg = (iss: string, over: Partial<OidcConfig> = {}): OidcConfig => ({ issuer: iss, audience: AUD, idClaim: 'preferred_username', caFile: ca.caFile, jwksFile: null, adminAudience: ADMIN_AUD, ...over });
async function readyVerifier(c: OidcConfig): Promise<OidcVerifier> {
  const v = createOidcVerifier(c, { log: () => {} });
  verifiers.push(v);
  for (let i = 0; i < 50 && !v.ready(); i++) await delay(20);
  if (!v.ready()) throw new Error('verifier never loaded its keys');
  return v;
}
const agentTok = (claims: Record<string, unknown> = {}, opts: Parameters<typeof accessToken>[2] = {}) =>
  accessToken(key, { iss: issuer!.url, aud: AUD, preferred_username: 'fred', sub: 'u-fred', client_id: 'preferred_username' in claims ? claims.preferred_username : 'fred', ...claims }, opts);
/** An admin access token; `scope` undefined leaves the claim out. */
const adminTok = (scope: unknown, claims: Record<string, unknown> = {}) =>
  accessToken(key, { iss: issuer!.url, aud: ADMIN_AUD, sub: 'svc-ops', ...(scope === undefined ? {} : { scope }), ...claims });

describe('R-406 admin configuration', () => {
  const base = { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh' };
  it('MESH_OIDC_ADMIN_AUDIENCE loads beside the agent audience; the switches default on and parse on/off', () => {
    const r = parseTokenAuthConfig({ ...base, MESH_OIDC_CA_FILE: ca.caFile, MESH_OIDC_ADMIN_AUDIENCE: ADMIN_AUD, MESH_STATIC_TOKENS: 'on', MESH_ADMIN_STATIC_TOKEN: 'off', MESH_METRICS_STATIC_TOKEN: 'off' });
    expect(r).toEqual({ ok: true, config: { oidc: { issuer: 'https://id.example', audience: 'mesh', idClaim: 'preferred_username', caFile: ca.caFile, jwksFile: null, adminAudience: ADMIN_AUD }, staticTokens: true, adminStaticToken: false, metricsStaticToken: false } });
    expect(parseTokenAuthConfig({ ...base, MESH_OIDC_CA_FILE: ca.caFile, MESH_STATIC_TOKENS: 'on', MESH_ADMIN_STATIC_TOKEN: 'on', MESH_METRICS_STATIC_TOKEN: 'on' }))
      .toMatchObject({ ok: true, config: { adminStaticToken: true, metricsStaticToken: true } });
  });

  it('GUARD: refuses to start when a switch would lock everyone out, the audiences coincide, or the admin audience has no issuer', () => {
    const cases: [Record<string, string>, string][] = [
      [{ MESH_ADMIN_STATIC_TOKEN: 'off' }, 'MESH_ADMIN_STATIC_TOKEN=off with no MESH_OIDC_ADMIN_AUDIENCE'],
      [{ ...base, MESH_OIDC_CA_FILE: ca.caFile, MESH_ADMIN_STATIC_TOKEN: 'off' }, 'MESH_ADMIN_STATIC_TOKEN=off with no MESH_OIDC_ADMIN_AUDIENCE'],
      [{ MESH_METRICS_STATIC_TOKEN: 'off' }, 'MESH_METRICS_STATIC_TOKEN=off with no MESH_OIDC_ADMIN_AUDIENCE'],
      [{ ...base, MESH_OIDC_CA_FILE: ca.caFile, MESH_OIDC_ADMIN_AUDIENCE: 'mesh' }, 'must differ'],
      [{ MESH_OIDC_ADMIN_AUDIENCE: ADMIN_AUD }, 'MESH_OIDC_ISSUER is not'],
      [{ MESH_ADMIN_STATIC_TOKEN: 'no' }, 'MESH_ADMIN_STATIC_TOKEN must be "on" or "off"'],
      [{ MESH_METRICS_STATIC_TOKEN: 'false' }, 'MESH_METRICS_STATIC_TOKEN must be "on" or "off"'],
    ];
    for (const [env, msg] of cases) {
      const r = parseTokenAuthConfig(env);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toContain(msg);
    }
  });
});

describe('W-1514 L12: with OIDC on, every static-token switch is explicit', () => {
  const whole = { MESH_OIDC_ISSUER: 'https://id.example', MESH_OIDC_AUDIENCE: 'mesh' };
  const all = { MESH_STATIC_TOKENS: 'on', MESH_ADMIN_STATIC_TOKEN: 'on', MESH_METRICS_STATIC_TOKEN: 'on' } as const;
  it('GUARD: refuses to start when any of the three is unset, naming the ones left out', () => {
    const env = { ...whole, MESH_OIDC_CA_FILE: ca.caFile };
    for (const left of Object.keys(all) as (keyof typeof all)[]) {
      const { [left]: _, ...rest } = all;
      const r = parseTokenAuthConfig({ ...env, ...rest });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toContain(`MESH_OIDC_ISSUER is set, so ${left} must`);
    }
    const none = parseTokenAuthConfig(env);
    expect(none.ok ? '' : none.error).toContain('MESH_STATIC_TOKENS, MESH_ADMIN_STATIC_TOKEN, MESH_METRICS_STATIC_TOKEN');
    expect(parseTokenAuthConfig({ ...env, ...all }).ok).toBe(true);
    expect(parseTokenAuthConfig({ ...env, MESH_STATIC_TOKENS: 'off', MESH_ADMIN_STATIC_TOKEN: 'off', MESH_METRICS_STATIC_TOKEN: 'off', MESH_OIDC_ADMIN_AUDIENCE: ADMIN_AUD }).ok).toBe(true);
  });

  it('control: without OIDC the switches still default on, as today', () => {
    expect(parseTokenAuthConfig({})).toEqual({ ok: true, config: { oidc: null, staticTokens: true, adminStaticToken: true, metricsStaticToken: true } });
  });
});

describe('R-406 admin verifier', () => {
  it('scope is RFC 9068\'s space-separated string; any other shape is no scopes', () => {
    expect([...scopesOf({ scope: 'mesh:acl  mesh:agents' })].sort()).toEqual(['mesh:acl', 'mesh:agents']);
    for (const scope of [undefined, '', ' ', ['mesh:acl'], 7, { 'mesh:acl': true }]) expect(scopesOf({ scope } as never).size).toBe(0);
  });

  it('GUARD: verifyAdmin takes only the admin audience, needs a sub, and is off without an admin audience', async () => {
    issuer = startIssuer(nextPort(), ca, [key]);
    const v = await readyVerifier(cfg(issuer.url));
    expect(await v.verifyAdmin(await adminTok('mesh:acl'))).toMatchObject({ ok: true, sub: 'svc-ops' });
    expect(await v.verifyAdmin(await agentTok({ scope: 'mesh:acl' }))).toMatchObject({ ok: false, reason: 'WRONG_AUDIENCE' });
    expect(await v.verifyAdmin(await adminTok('mesh:acl', { sub: undefined }))).toMatchObject({ ok: false, reason: 'NO_SUB' });
    // And the other way: an admin token is not an agent login.
    expect(await v.verify(await adminTok('mesh:acl', { preferred_username: 'fred' }))).toMatchObject({ ok: false, reason: 'WRONG_AUDIENCE' });
    const off = await readyVerifier(cfg(issuer.url, { adminAudience: null }));
    expect(off.adminAudience).toBeNull();
    expect(await off.verifyAdmin(await adminTok('mesh:acl'))).toMatchObject({ ok: false, reason: 'ADMIN_OFF' });
  });

  it('GUARD: an agent login token needs a sub, since the name is bound to it', async () => {
    issuer = startIssuer(nextPort(), ca, [key]);
    const v = await readyVerifier(cfg(issuer.url));
    expect(await v.verify(await agentTok())).toMatchObject({ ok: true, identity: 'fred', sub: 'u-fred' });
    expect(await v.verify(await agentTok({ sub: undefined }))).toMatchObject({ ok: false, reason: 'NO_SUB' });
    expect(await v.verify(await agentTok({ sub: '' }))).toMatchObject({ ok: false, reason: 'NO_SUB' });
  });
});

type Frame = Record<string, unknown>;

describe('R-406 admin API on the wire', () => {
  let db: Database;
  let ws: WsServerHandle | undefined;
  let admin: HttpAdminHandle | undefined;
  let wsPort: number;
  let base: string;
  let lines: string[];
  const realLog = console.log;
  const opened: WebSocket[] = [];

  async function up(opts: { adminStatic?: boolean; metricsStatic?: boolean; metricsToken?: string | null; adminAudience?: string | null } = {}): Promise<void> {
    issuer = startIssuer(nextPort(), ca, [key]);
    const v = await readyVerifier(cfg(issuer.url, opts.adminAudience === undefined ? {} : { adminAudience: opts.adminAudience }));
    const tokenAuth = { oidc: v, staticTokens: true };
    wsPort = nextPort();
    ws = await startWsServer(wsPort, db, 10_485_760, tmp('r406a-ws-'), 0, new Map(), null, { tokenAuth });
    admin = await startHttpAdmin(0, db, 'adm', 10_485_760, tmp('r406a-adm-'), ws.agentIndex, ws.observerIndex, new Map(), {}, {
      tokenAuth, adminTokenPrev: 'adm-prev', metricsToken: opts.metricsToken ?? null,
      ...(opts.adminStatic === undefined ? {} : { adminStaticToken: opts.adminStatic }),
      ...(opts.metricsStatic === undefined ? {} : { metricsStaticToken: opts.metricsStatic }),
    });
    base = `http://127.0.0.1:${(admin.server.address() as net.AddressInfo).port}`;
  }
  const call = async (method: string, path: string, bearer: string | null, body?: unknown): Promise<number> =>
    (await fetch(`${base}${path}`, {
      method,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })).status;

  async function login(auth: Record<string, unknown>): Promise<{ sock: WebSocket; reply: Frame; frames: Frame[] }> {
    const sock = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    opened.push(sock);
    await new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
    const frames: Frame[] = [];
    const reply = await new Promise<Frame>((resolve) => {
      let first = true;
      sock.on('message', (d) => { const f = JSON.parse(d.toString()) as Frame; if (first) { first = false; resolve(f); return; } frames.push(f); });
      sock.send(JSON.stringify({ type: 'auth', ...auth }));
    });
    return { sock, reply, frames };
  }

  beforeEach(() => {
    db = openDb(':memory:');
    lines = [];
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    for (const id of ['fred', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
  });
  afterEach(async () => {
    console.log = realLog;
    for (const s of opened.splice(0)) { try { s.close(); } catch { /* ignore */ } }
    await ws?.shutdown().catch(() => {});
    await admin?.shutdown().catch(() => {});
    ws = undefined; admin = undefined;
    db.close();
  });

  it('GUARD: each route takes only its own scope: mesh:agents:read, mesh:agents:write, mesh:acl, mesh:reminders', async () => {
    await up();
    const read = await adminTok('mesh:agents:read');
    const write = await adminTok('mesh:agents:write');
    const acl = await adminTok('mesh:acl');
    const reminders = await adminTok('mesh:reminders');
    expect(await call('GET', '/agents', read)).toBe(200);
    expect(await call('GET', '/agents/fred', read)).toBe(200);
    // W-1514 M10: reading the roster doesn't let you change it.
    expect(await call('PATCH', '/agents/fred', read, { namespace: 'x' })).toBe(401);
    expect(await call('POST', '/agents/fred/rotate', read)).toBe(401);
    expect(await call('DELETE', '/agents/bob', read)).toBe(401);
    expect(await call('POST', '/observers', read, { agent_id: 'fred' })).toBe(401);
    expect(await call('GET', '/agents', write)).toBe(401);
    expect(await call('PATCH', '/agents/fred', write, { namespace: 'x' })).toBe(200);
    expect(await call('POST', '/agents/fred/rotate', write)).toBe(200);
    expect(await call('GET', '/acl?agent=fred', read)).toBe(401);
    expect(await call('GET', '/reminders', read)).toBe(401);
    expect(await call('POST', '/acl', acl, { from_agent: 'fred', to_agent: 'bob' })).toBe(201);
    expect(await call('GET', '/acl?agent=fred', acl)).toBe(200);
    expect(await call('GET', '/agents', acl)).toBe(401);
    expect(await call('GET', '/reminders', reminders)).toBe(200);
    expect(await call('GET', '/agents', reminders)).toBe(401);
    // Several scopes in one token each count.
    expect(await call('GET', '/acl?agent=fred', await adminTok('mesh:agents:read mesh:acl'))).toBe(200);
    expect(await call('DELETE', '/agents/bob', write)).toBe(200);
    expect(getAgentById(db, 'bob')).toBeNull();
  });

  it('GUARD: no catch-all scope, and an empty or missing scope grants nothing', async () => {
    await up();
    // Plain mesh:agents (before the W-1514 M10 split) grants nothing now.
    for (const scope of ['*', 'mesh:*', 'mesh', 'mesh:admin', 'admin', 'mesh:agents', 'mesh:agents:*', 'mesh:agents:admin', 'MESH:AGENTS:READ', '', ' ', undefined, ['mesh:agents:read']]) {
      expect(await call('GET', '/agents', await adminTok(scope))).toBe(401);
      expect(await call('PATCH', '/agents/fred', await adminTok(scope), { namespace: 'x' })).toBe(401);
    }
  });

  it('GUARD: every other admin route takes its own scope, and no other', async () => {
    await up();
    const cases: [string, string, string][] = [
      ['GET', '/observers', 'mesh:agents:read'],
      ['POST', '/observers', 'mesh:agents:write'],
      ['DELETE', '/observers/fred', 'mesh:agents:write'],
      ['DELETE', '/agents/fred/tls-latch', 'mesh:agents:write'],
      ['GET', '/connections', 'mesh:metrics'],
      ['GET', '/topics', 'mesh:topics'],
      ['POST', '/files', 'mesh:files'],
      ['GET', '/peers', 'mesh:peers'],
      ['GET', '/peer-keys', 'mesh:peers'],
      ['GET', '/outbound-peers', 'mesh:peers'],
    ];
    const allScopes = ['mesh:agents:read', 'mesh:agents:write', 'mesh:acl', 'mesh:reminders', 'mesh:topics', 'mesh:files', 'mesh:peers', 'mesh:metrics'];
    for (const [method, path, scope] of cases) {
      // Reached (the handler may still refuse the request itself, e.g. no body).
      expect(await call(method, path, await adminTok(scope))).not.toBe(401);
      expect(await call(method, path, await adminTok(allScopes.filter(x => x !== scope).join(' ')))).toBe(401);
    }
  });

  it('GUARD: an unknown path takes no access token, whatever its scope; the static admin token gets the 404', async () => {
    await up();
    const all = await adminTok('mesh:agents:read mesh:agents:write mesh:acl mesh:reminders mesh:topics mesh:files mesh:peers mesh:metrics');
    for (const [method, path] of [['GET', '/no-such-route'], ['PUT', '/agents'], ['GET', '/agents/fred/nope']] as const) {
      expect(await call(method, path, all)).toBe(401);
    }
    expect(await call('GET', '/no-such-route', 'adm')).toBe(404);
    expect(lines.some(l => l.includes('"evt":"admin.auth"') && l.includes('"reason":"route_unmapped"') && l.includes('"sub":"svc-ops"'))).toBe(true);
  });

  it('GUARD: an agent\'s login token is not an admin credential, nor an admin token an agent one', async () => {
    await up();
    expect(await call('GET', '/agents', await agentTok({ scope: 'mesh:agents:read' }))).toBe(401);
    expect(await call('GET', '/messages', await adminTok('mesh:agents:read'))).toBe(401);
    expect(lines.some(l => l.includes('"reason":"oidc_wrong_audience"'))).toBe(true);
  });

  it('GUARD: with no admin audience, an admin token reaches nothing', async () => {
    await up({ adminAudience: null });
    expect(await call('GET', '/agents', await adminTok('mesh:agents:read'))).toBe(401);
    expect(await call('GET', '/agents', 'adm')).toBe(200);
  });

  it('GUARD: MESH_ADMIN_STATIC_TOKEN=off refuses the admin token and _PREV on every route and on /metrics; access tokens still work', async () => {
    await up({ adminStatic: false, metricsToken: 'met' });
    for (const tok of ['adm', 'adm-prev']) {
      expect(await call('GET', '/agents', tok)).toBe(401);
      expect(await call('GET', '/topics', tok)).toBe(401);
      expect(await call('GET', '/no-such-route', tok)).toBe(401);
      expect(await call('GET', '/messages', tok)).toBe(401);
      expect(await call('GET', '/metrics', tok)).toBe(401);
    }
    expect(await call('GET', '/agents', await adminTok('mesh:agents:read'))).toBe(200);
    expect(await call('GET', '/metrics', 'met')).toBe(200);
  });

  it('control: with the switch on, the admin token and _PREV work as today', async () => {
    await up({ metricsToken: 'met' });
    for (const tok of ['adm', 'adm-prev']) {
      expect(await call('GET', '/agents', tok)).toBe(200);
      expect(await call('GET', '/messages', tok)).toBe(200);
      expect(await call('GET', '/metrics', tok)).toBe(200);
    }
  });

  it('GUARD: /metrics takes an admin access token with mesh:metrics, and no other scope', async () => {
    await up({ metricsToken: 'met' });
    expect(await call('GET', '/metrics', await adminTok('mesh:metrics'))).toBe(200);
    expect(await call('GET', '/metrics', await adminTok('mesh:agents mesh:acl mesh:reminders'))).toBe(401);
    expect(await call('GET', '/metrics', await adminTok(''))).toBe(401);
    expect(await call('GET', '/metrics', await agentTok({ scope: 'mesh:metrics' }))).toBe(401);
    expect(await call('GET', '/metrics', 'met')).toBe(200);
    expect(lines.some(l => l.includes('"evt":"metrics.auth"') && l.includes('"reason":"scope_missing"') && l.includes('"sub":"svc-ops"'))).toBe(true);
  });

  it('GUARD: MESH_METRICS_STATIC_TOKEN=off refuses the metrics token and never leaves /metrics open', async () => {
    await up({ metricsStatic: false, metricsToken: 'met' });
    expect(await call('GET', '/metrics', 'met')).toBe(401);
    expect(await call('GET', '/metrics', null)).toBe(401);
    expect(await call('GET', '/metrics', await adminTok('mesh:metrics'))).toBe(200);
    // The admin token has its own switch, still on here.
    expect(await call('GET', '/metrics', 'adm')).toBe(200);
    const boot = lines.find(l => l.includes('"evt":"admin.listening"'))!;
    expect(boot).toContain('"metrics_auth":"oauth"');
    expect(boot).not.toContain('metrics_unauthenticated');
  });

  it('control: with no metrics token and the switch on, /metrics stays open as today', async () => {
    await up();
    expect(await call('GET', '/metrics', null)).toBe(200);
  });

  it('the admin caller\'s sub is logged on admin.auth, agent.http and admin.mutation; the token never is', async () => {
    await up();
    const t = await adminTok('mesh:agents:write');
    expect(await call('PATCH', '/agents/fred', t, { namespace: 'h3' })).toBe(200);
    const sig = t.split('.')[2]!;
    const evt = (name: string) => lines.find(l => l.includes(`"evt":"${name}"`) && l.includes('"sub":"svc-ops"'));
    expect(evt('admin.auth')).toContain('"outcome":"success"');
    expect(evt('agent.http')).toContain('"principal":"admin"');
    expect(evt('admin.mutation')).toContain('"actor":"admin"');
    expect(lines.join('\n')).not.toContain(sig);
    // A refused one says who was refused, and why.
    expect(await call('GET', '/acl?agent=fred', t)).toBe(401);
    expect(lines.some(l => l.includes('"outcome":"failure"') && l.includes('"reason":"scope_missing"') && l.includes('"sub":"svc-ops"'))).toBe(true);
    // The static token has no caller to name.
    lines.length = 0;
    expect(await call('GET', '/agents', 'adm')).toBe(200);
    expect(lines.find(l => l.includes('"evt":"admin.auth"'))).toContain('"sub":null');
  });

  it('GUARD (W-1514 H3): an existing row nobody has bound is refused by OIDC, observers included; nothing is bound', async () => {
    await up();
    grantObserver(db, 'bob', 'admin', false);
    for (const who of ['fred', 'bob']) {
      const t = await agentTok({ preferred_username: who, sub: `u-${who}` });
      const r = await login({ agent_id: who, token: t });
      expect(r.reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
      expect(JSON.stringify(r.reply)).not.toContain('UNBOUND');
      expect(await call('GET', '/messages', t)).toBe(401);
      expect(getAgentById(db, who)?.oidc_sub).toBeNull();
    }
    expect(lines.some(l => l.includes('"refused":"oidc_unbound"'))).toBe(true);
  });

  it('GUARD: a name with no row is created by its first OIDC login and bound to its sub', async () => {
    await up();
    expect((await login({ agent_id: 'newbie', token: await agentTok({ preferred_username: 'newbie', sub: 'u-newbie' }) })).reply).toMatchObject({ type: 'auth_ok' });
    expect(getAgentById(db, 'newbie')?.oidc_sub).toBe('u-newbie');
    expect((await login({ agent_id: 'newbie', token: await agentTok({ preferred_username: 'newbie', sub: 'u-newbie' }) })).reply).toMatchObject({ type: 'auth_ok' });
    expect((await login({ agent_id: 'newbie', token: await agentTok({ preferred_username: 'newbie', sub: 'u-other' }) })).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
  });

  it('GUARD: an admin binds a row with PATCH {oidc_sub} under mesh:agents:write (logged with their sub); null unbinds; mesh:agents:read can\'t', async () => {
    await up();
    grantObserver(db, 'bob', 'admin', false);
    expect(await call('PATCH', '/agents/fred', await adminTok('mesh:agents:read'), { oidc_sub: 'u-fred' })).toBe(401);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
    const write = await adminTok('mesh:agents:write');
    expect(await call('PATCH', '/agents/fred', write, { oidc_sub: 'u-fred' })).toBe(200);
    expect(lines.some(l => l.includes('"evt":"agent.oidc_sub_set"') && l.includes('"agent_id":"fred"') && l.includes('"oidc_sub":"u-fred"') && l.includes('"by_sub":"svc-ops"'))).toBe(true);
    expect((await login({ agent_id: 'fred', token: await agentTok() })).reply).toMatchObject({ type: 'auth_ok' });
    // An observer an admin has bound logs in with that sub.
    expect(await call('PATCH', '/agents/bob', write, { oidc_sub: 'u-bob' })).toBe(200);
    expect((await login({ agent_id: 'bob', token: await agentTok({ preferred_username: 'bob', sub: 'u-bob' }) })).reply).toMatchObject({ type: 'auth_ok' });
    for (const bad of ['', 7, 'x'.repeat(257), ['u-fred']]) expect(await call('PATCH', '/agents/fred', write, { oidc_sub: bad })).toBe(400);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
    expect(await call('PATCH', '/agents/fred', write, { oidc_sub: null })).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
    expect((await login({ agent_id: 'fred', token: await agentTok() })).reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    // A PATCH that doesn't name oidc_sub leaves the binding alone.
    setOidcSub(db, 'fred', 'u-fred');
    expect(await call('PATCH', '/agents/fred', write, { namespace: 'n' })).toBe(200);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
  });

  it('GUARD: a different sub for a bound name is refused on login (WS and HTTP), with the uniform AUTH_FAILED', async () => {
    await up();
    setOidcSub(db, 'fred', 'u-fred');
    const imposter = await agentTok({ sub: 'u-someone-else' });
    const r = await login({ agent_id: 'fred', token: imposter });
    expect(r.reply).toMatchObject({ type: 'error', code: 'AUTH_FAILED' });
    expect(JSON.stringify(r.reply)).not.toContain('SUB');
    expect(lines.some(l => l.includes('"refused":"oidc_sub_mismatch"') || l.includes('"refused":"sub_mismatch"'))).toBe(true);
    expect(await call('GET', '/messages', imposter)).toBe(401);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
  });

  it('GUARD: re-auth with a different sub, or after an admin unbinds, is refused, and the session is unchanged', async () => {
    await up();
    setOidcSub(db, 'fred', 'u-fred');
    const s = await login({ agent_id: 'fred', token: await agentTok({}, { expIn: 120 }) });
    expect(s.reply).toMatchObject({ type: 'auth_ok' });
    s.sock.send(JSON.stringify({ type: 'auth', msg_id: 'other', agent_id: 'fred', token: await agentTok({ sub: 'u-someone-else' }, { expIn: 600 }) }));
    s.sock.send(JSON.stringify({ type: 'auth', msg_id: 'same', agent_id: 'fred', token: await agentTok({}, { expIn: 600 }) }));
    for (let i = 0; i < 50 && s.frames.length < 2; i++) await delay(20);
    expect(s.frames.find(f => f.ref === 'other')).toMatchObject({ type: 'error', code: 'REAUTH_REFUSED' });
    expect(s.frames.find(f => f.ref === 'same')).toMatchObject({ type: 'ack', ok: true });
    expect(lines.some(l => l.includes('"refused":"sub_mismatch"'))).toBe(true);
    setOidcSub(db, 'fred', null);
    s.sock.send(JSON.stringify({ type: 'auth', msg_id: 'unbound', agent_id: 'fred', token: await agentTok({}, { expIn: 900 }) }));
    for (let i = 0; i < 50 && s.frames.length < 3; i++) await delay(20);
    expect(s.frames.find(f => f.ref === 'unbound')).toMatchObject({ type: 'error', code: 'REAUTH_REFUSED' });
    expect(lines.some(l => l.includes('"refused":"oidc_unbound"'))).toBe(true);
    expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
  });

  it('a static-token login does not touch the binding', async () => {
    await up();
    expect((await login({ agent_id: 'bob', token: 'bob-tok' })).reply).toMatchObject({ type: 'auth_ok' });
    expect(getAgentById(db, 'bob')?.oidc_sub).toBeNull();
    setOidcSub(db, 'fred', 'u-fred');
    expect((await login({ agent_id: 'fred', token: 'fred-tok' })).reply).toMatchObject({ type: 'auth_ok' });
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-fred');
  });

  it('deleting an agent frees its name: the next OIDC login creates and binds it afresh', async () => {
    await up();
    setOidcSub(db, 'fred', 'u-fred');
    expect(await call('DELETE', '/agents/fred', 'adm')).toBe(200);
    expect((await login({ agent_id: 'fred', token: await agentTok({ sub: 'u-new-fred' }) })).reply).toMatchObject({ type: 'auth_ok' });
    expect(getAgentById(db, 'fred')?.oidc_sub).toBe('u-new-fred');
  });
});

describe('R-406 oidc_sub migration', () => {
  it('adds the column to an existing agents table, keeps its rows unbound, and re-runs as a no-op', () => {
    const path = join(tmp('r406a-mig-'), 'old.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, hostname TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', namespace TEXT, registered_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 0)`);
    old.exec(`INSERT INTO agents (id, token_hash, hostname, registered_at, last_seen) VALUES ('fred', 'x', 'h', 1, 1)`);
    old.close();
    for (let boot = 0; boot < 2; boot++) {
      const db = openDb(path);
      const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).filter(c => c.name === 'oidc_sub');
      expect(cols).toHaveLength(1);
      expect(getAgentById(db, 'fred')?.oidc_sub).toBeNull();
      db.close();
    }
  });

  it('oidcSubState reads the binding; setOidcSub is the only writer and changes nothing for a missing row', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'fred', token_hash: 'x', hostname: 'h' });
    expect(oidcSubState(db, 'fred', 'a')).toBe('unbound');
    expect(setOidcSub(db, 'fred', 'a')).toBe(true);
    expect(oidcSubState(db, 'fred', 'a')).toBe('bound');
    expect(oidcSubState(db, 'fred', 'b')).toBe('mismatch');
    expect(oidcSubState(db, 'nobody', 'a')).toBe('missing');
    expect(setOidcSub(db, 'nobody', 'a')).toBe(false);
    db.close();
  });
});
