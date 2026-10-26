// W-1514 switch-on review: the reviewer's proofs against the mesh's OIDC door,
// inverted. Each proof passed while the weakness was there; each test here
// asserts it is gone, and is paired with a mutant in the PR:
//   H3  an existing unbound row (an observer here) can't be claimed by the
//       first OIDC login; the owner gets in once an admin binds the row;
//   M9  an exchanged person token (`act`) and another service's token
//       (client_id isn't the identity) are not agent logins;
//   M7  a key the issuer has dropped stops verifying once the key set is
//       past JWKS_MAX_AGE_MS; an unreachable issuer keeps the cached set for
//       at most JWKS_STALE_LIMIT_MS.
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { openDb, registerAgent, getAgentById, grantObserver, isObserver, aclGrant, setOidcSub } from '../db.ts';
import { hashToken } from '../auth.ts';
import { createOidcVerifier, JWKS_MAX_AGE_MS, JWKS_REFETCH_MIN_MS, JWKS_STALE_LIMIT_MS, type OidcVerifier } from '../oidc.ts';
import { authenticateJwt, authenticateAgentCredential, type TokenAuth } from '../token-auth.ts';
import { accessToken, makeKey, type TestKey } from './helpers/test-issuer.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup } = tempDirs();
afterAll(cleanup);
const ISS = 'https://id.example';
const AUD = 'mesh';
let key: TestKey;
let verifier: OidcVerifier;
let auth: TokenAuth;
beforeAll(async () => {
  key = await makeKey('k1', 'ES256');
  const jwksFile = join(tmp('w1514-'), 'jwks.json');
  writeFileSync(jwksFile, JSON.stringify({ keys: [key.jwk] }));
  verifier = createOidcVerifier({ issuer: ISS, audience: AUD, idClaim: 'preferred_username', caFile: null, jwksFile }, { log: () => {} });
  auth = { oidc: verifier, staticTokens: true };
});
afterAll(() => verifier.stop());

const agentToken = (who: string, sub: string, extra: Record<string, unknown> = {}) =>
  accessToken(key, { iss: ISS, aud: AUD, preferred_username: who, sub, client_id: who, ...extra });

describe('W-1514 H3: the first OIDC login claims no existing row', () => {
  it('an unbound observer row refuses every OIDC login (OIDC_UNBOUND) and stays unbound; an admin binding lets the owner in', async () => {
    const db = openDb(':memory:');
    const STATIC = 'a'.repeat(64);
    registerAgent(db, { id: 'spawner-web', token_hash: hashToken(STATIC), hostname: 'spawner-web-host' });
    grantObserver(db, 'spawner-web', 'admin', false);
    registerAgent(db, { id: 'platform-planner', token_hash: hashToken('b'.repeat(64)), hostname: 'claude-platform-planner' });
    aclGrant(db, 'spawner-web', 'platform-planner', 'admin');
    expect(await authenticateJwt(db, await agentToken('spawner-web', 'attacker-uuid'), auth)).toMatchObject({ ok: false, reason: 'OIDC_UNBOUND' });
    expect(getAgentById(db, 'spawner-web')!.oidc_sub).toBeNull();
    expect(isObserver(db, 'spawner-web')).toBe(true);
    // The owner too, until an admin binds the row; then only the owner.
    expect(await authenticateJwt(db, await agentToken('spawner-web', 'owner-uuid'), auth)).toMatchObject({ ok: false, reason: 'OIDC_UNBOUND' });
    setOidcSub(db, 'spawner-web', 'owner-uuid');
    expect(await authenticateJwt(db, await agentToken('spawner-web', 'owner-uuid'), auth)).toMatchObject({ ok: true, agentId: 'spawner-web', created: false });
    expect(await authenticateJwt(db, await agentToken('spawner-web', 'attacker-uuid'), auth)).toMatchObject({ ok: false, reason: 'SUB_MISMATCH' });
    // The static token is MESH_STATIC_TOKENS' business, unchanged here.
    expect(await authenticateAgentCredential(db, STATIC, auth)).toMatchObject({ ok: true, agentId: 'spawner-web', via: 'static' });
  });
});

describe('W-1514 M9: only an agent\'s own token is an agent login', () => {
  it('an exchanged person token (act, the bridge as client_id) is refused and creates nothing', async () => {
    const db = openDb(':memory:');
    const t = await accessToken(key, { iss: ISS, aud: AUD, preferred_username: 'alice', sub: 'person-uuid', client_id: 'fleet-bridge', act: { sub: 'fleet-bridge' }, scope: 'action:mesh.send' });
    expect(await authenticateJwt(db, t, auth)).toMatchObject({ ok: false, reason: 'ACTOR_TOKEN' });
    // `act` alone is enough, whatever the client_id.
    expect(await authenticateJwt(db, await agentToken('alice', 'person-uuid', { act: { sub: 'fleet-bridge' } }), auth)).toMatchObject({ ok: false, reason: 'ACTOR_TOKEN' });
    expect(getAgentById(db, 'alice')).toBeNull();
  });

  it('a token whose client_id isn\'t its identity (or has none) is refused and creates nothing', async () => {
    const db = openDb(':memory:');
    for (const client_id of ['other-service', undefined, '', ['some-service']]) {
      const t = await accessToken(key, { iss: ISS, aud: AUD, preferred_username: 'some-service', sub: 'svc-uuid', ...(client_id === undefined ? {} : { client_id }) });
      expect(await authenticateJwt(db, t, auth)).toMatchObject({ ok: false, reason: 'CLIENT_MISMATCH' });
    }
    expect(getAgentById(db, 'some-service')).toBeNull();
    // control: the agent's own client_credentials token
    expect(await authenticateJwt(db, await agentToken('some-service', 'svc-uuid'), auth)).toMatchObject({ ok: true, created: true });
  });

  it('with MESH_OIDC_ID_CLAIM=sub, client_id must equal the sub', async () => {
    const jwksFile = join(tmp('w1514sub-'), 'jwks.json');
    writeFileSync(jwksFile, JSON.stringify({ keys: [key.jwk] }));
    const v = createOidcVerifier({ issuer: ISS, audience: AUD, idClaim: 'sub', caFile: null, jwksFile }, { log: () => {} });
    expect(await v.verify(await accessToken(key, { iss: ISS, aud: AUD, sub: 'robot1', client_id: 'robot1' }))).toMatchObject({ ok: true, identity: 'robot1' });
    expect(await v.verify(await accessToken(key, { iss: ISS, aud: AUD, sub: 'robot1', preferred_username: 'robot1', client_id: 'robot2' }))).toMatchObject({ ok: false, reason: 'CLIENT_MISMATCH' });
    v.stop();
  });
});

describe('W-1514 M7: the key set has a maximum age', () => {
  const day = 24 * 3600;
  async function issuerWith(keys: TestKey[]) {
    const state = { served: keys.map(k => k.jwk), down: false, fetches: 0, attempts: 0 };
    let clock = Date.now();
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith('/.well-known/openid-configuration')) state.attempts++;
      if (state.down) throw new Error('issuer unreachable');
      if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: ISS, jwks_uri: `${ISS}/jwks` });
      state.fetches++;
      return Response.json({ keys: state.served });
    }) as unknown as typeof fetch;
    const caFile = join(tmp('w1514ca-'), 'ca.pem');
    writeFileSync(caFile, 'unused');
    const v = createOidcVerifier({ issuer: ISS, audience: AUD, idClaim: 'preferred_username', caFile, jwksFile: null }, { fetchImpl, now: () => clock, log: () => {} });
    for (let i = 0; i < 50 && !v.ready(); i++) await Bun.sleep(10);
    return { v, state, advance: (ms: number) => { clock += ms; } };
  }
  // Tokens that outlive the simulated clock, so only the keys decide.
  const longToken = (k: TestKey) => accessToken(k, { iss: ISS, aud: AUD, preferred_username: 'fred', sub: 'x', client_id: 'fred' }, { expIn: 60 * day });

  it('a key dropped from the issuer stops verifying once the set is past JWKS_MAX_AGE_MS', async () => {
    const a = await makeKey('A', 'ES256');
    const b = await makeKey('B', 'ES256');
    const { v, state, advance } = await issuerWith([a, b]);
    const forged = await longToken(b);
    expect(await v.verify(forged)).toMatchObject({ ok: true });
    state.served = [a.jwk]; // the operator removes compromised key B
    advance(JWKS_MAX_AGE_MS - 1000);
    expect(await v.verify(forged)).toMatchObject({ ok: true }); // still within the max age
    advance(2000);
    expect(await v.verify(forged)).toMatchObject({ ok: false, reason: 'UNKNOWN_KID' });
    expect(await v.verify(await longToken(a))).toMatchObject({ ok: true });
    v.stop();
  });

  it('verifies that arrive while the refetch is running wait for it, so none slips through on the old set', async () => {
    const a = await makeKey('A', 'ES256');
    const b = await makeKey('B', 'ES256');
    const { v, state, advance } = await issuerWith([a, b]);
    const forged = await longToken(b);
    state.served = [a.jwk];
    advance(JWKS_MAX_AGE_MS + 1);
    const results = await Promise.all([v.verify(forged), v.verify(forged), v.verify(forged)]);
    for (const r of results) expect(r).toMatchObject({ ok: false, reason: 'UNKNOWN_KID' });
    v.stop();
  });

  it('an unreachable issuer keeps the cached set up to JWKS_STALE_LIMIT_MS, then refuses with OIDC_NOT_READY', async () => {
    const a = await makeKey('A', 'ES256');
    const { v, state, advance } = await issuerWith([a]);
    const t = await longToken(a);
    state.down = true;
    advance(JWKS_STALE_LIMIT_MS - 60_000);
    expect(await v.verify(t)).toMatchObject({ ok: true });
    advance(120_000);
    expect(await v.verify(t)).toMatchObject({ ok: false, reason: 'OIDC_NOT_READY' });
    state.down = false;
    advance(JWKS_REFETCH_MIN_MS);
    expect(await v.verify(t)).toMatchObject({ ok: true }); // recovers on the next good refetch
    v.stop();
  });

  it('a stale set refetches at most once a minute while the issuer is down, and a fresh set not at all', async () => {
    const a = await makeKey('A', 'ES256');
    const { v, state, advance } = await issuerWith([a]);
    const t = await longToken(a);
    const base = state.fetches;
    await v.verify(t);
    await v.verify(t);
    expect(state.fetches).toBe(base);
    advance(JWKS_MAX_AGE_MS + 1);
    await Promise.all([v.verify(t), v.verify(t), v.verify(t)]);
    expect(state.fetches).toBe(base + 1); // one refetch for the three
    state.down = true;
    advance(JWKS_MAX_AGE_MS + 1);
    const tried = state.attempts;
    for (let i = 0; i < 5; i++) expect(await v.verify(t)).toMatchObject({ ok: true });
    expect(state.attempts).toBe(tried + 1);
    advance(JWKS_REFETCH_MIN_MS);
    await v.verify(t);
    expect(state.attempts).toBe(tried + 2);
    v.stop();
  });
});
