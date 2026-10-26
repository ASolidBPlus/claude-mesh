// R-406: MESH_OIDC_KEYS_URL. The issuer's public origin sits behind a proxy
// whose certificate rotates, so it can't be pinned; the mesh fetches the
// discovery document and JWKS from an internal base over the pinned CA
// instead. The guards pinned here, each with a mutant in the PR: the document
// must name the public issuer exactly; its jwks_uri must be on the issuer's
// origin; the keys are fetched from the internal base, never the public URL;
// tokens' `iss` is still the public issuer; unset is today's path.
import { describe, it, expect, afterAll } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { createOidcVerifier, parseTokenAuthConfig, type OidcConfig } from '../oidc.ts';
import { accessToken, makeKey } from './helpers/test-issuer.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup } = tempDirs();
afterAll(cleanup);
const ISS = 'https://login.example';
const KEYS = 'https://fleet-auth.internal:18080';
const AUD = 'mesh';

describe('R-406 MESH_OIDC_KEYS_URL configuration', () => {
  const caFile = join(tmp('r406k-'), 'ca.pem');
  writeFileSync(caFile, 'unused');
  const whole = { MESH_OIDC_ISSUER: ISS, MESH_OIDC_AUDIENCE: AUD, MESH_OIDC_CA_FILE: caFile, MESH_STATIC_TOKENS: 'on', MESH_ADMIN_STATIC_TOKEN: 'on', MESH_METRICS_STATIC_TOKEN: 'on' };

  it('loads beside the issuer; unset is null', () => {
    expect(parseTokenAuthConfig({ ...whole, MESH_OIDC_KEYS_URL: KEYS })).toMatchObject({ ok: true, config: { oidc: { issuer: ISS, keysUrl: KEYS, caFile } } });
    expect(parseTokenAuthConfig(whole)).toMatchObject({ ok: true, config: { oidc: { keysUrl: null } } });
  });

  it('GUARD: refuses to start when it is not https, not a URL, set without the issuer, or set beside a local JWKS file', () => {
    const jwksFile = join(tmp('r406k-'), 'jwks.json');
    writeFileSync(jwksFile, JSON.stringify({ keys: [] }));
    const cases: [Record<string, string>, string][] = [
      [{ ...whole, MESH_OIDC_KEYS_URL: 'http://fleet-auth.internal:18080' }, 'MESH_OIDC_KEYS_URL must be https'],
      [{ ...whole, MESH_OIDC_KEYS_URL: 'fleet-auth.internal' }, 'MESH_OIDC_KEYS_URL is not a URL'],
      [{ MESH_OIDC_KEYS_URL: KEYS }, 'MESH_OIDC_ISSUER is not'],
      [{ ...whole, MESH_OIDC_CA_FILE: '', MESH_OIDC_JWKS_FILE: jwksFile, MESH_OIDC_KEYS_URL: KEYS }, "can't be used with MESH_OIDC_JWKS_FILE"],
    ];
    for (const [env, msg] of cases) {
      const r = parseTokenAuthConfig(env);
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.error).toContain(msg);
    }
  });
});

describe('R-406 discovery through MESH_OIDC_KEYS_URL', () => {
  async function verifierWith(doc: (base: string) => Record<string, unknown>, keysUrl: string | null) {
    const key = await makeKey('k1', 'ES256');
    const fetched: string[] = [];
    const logs: Record<string, unknown>[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(String(url));
      if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json(doc(String(url)));
      return Response.json({ keys: [key.jwk] });
    }) as unknown as typeof fetch;
    const caFile = join(tmp('r406kv-'), 'ca.pem');
    writeFileSync(caFile, 'unused');
    const config: OidcConfig = { issuer: ISS, audience: AUD, idClaim: 'preferred_username', caFile, jwksFile: null, keysUrl };
    const v = createOidcVerifier(config, { fetchImpl, log: (f) => logs.push(f) });
    for (let i = 0; i < 30 && !v.ready() && !logs.some(l => l.outcome === 'jwks_unavailable'); i++) await Bun.sleep(10);
    const token = (iss = ISS) => accessToken(key, { iss, aud: AUD, preferred_username: 'fred', sub: 'u-fred', client_id: 'fred' });
    return { v, fetched, logs, token };
  }

  it('GUARD: fetches the document and the JWKS path (with its query) from the keys base, never the public origin; tokens still carry the public iss', async () => {
    const { v, fetched, token } = await verifierWith(() => ({ issuer: ISS, jwks_uri: `${ISS}/oauth/jwks?v=2#frag` }), `${KEYS}/`);
    expect(v.ready()).toBe(true);
    expect(fetched).toEqual([`${KEYS}/.well-known/openid-configuration`, `${KEYS}/oauth/jwks?v=2`]);
    expect(fetched.some(u => u.startsWith(ISS))).toBe(false);
    expect(await v.verify(await token())).toMatchObject({ ok: true, identity: 'fred' });
    // The token's iss must be the public issuer, not the keys base.
    for (const iss of [KEYS, `${KEYS}/`]) expect(await v.verify(await token(iss))).toMatchObject({ ok: false, reason: 'WRONG_ISSUER' });
    v.stop();
  });

  it('GUARD: a document whose issuer is not exactly MESH_OIDC_ISSUER is refused and logged', async () => {
    for (const issuer of [KEYS, `${ISS}/`, 'https://login.example.evil', undefined]) {
      const { v, logs, token } = await verifierWith(() => ({ issuer, jwks_uri: `${ISS}/jwks` }), KEYS);
      expect(v.ready()).toBe(false);
      expect(logs.some(l => l.outcome === 'jwks_unavailable' && String(l.error).includes('different issuer'))).toBe(true);
      expect(await v.verify(await token())).toMatchObject({ ok: false, reason: 'OIDC_NOT_READY' });
      v.stop();
    }
  });

  it('GUARD: a jwks_uri on any other origin is refused, and nothing is fetched from it', async () => {
    for (const jwks_uri of [`${KEYS}/jwks`, 'https://evil.example/jwks', 'https://login.example:8443/jwks', 'https://sub.login.example/jwks']) {
      const { v, fetched, logs } = await verifierWith(() => ({ issuer: ISS, jwks_uri }), KEYS);
      expect(v.ready()).toBe(false);
      expect(logs.some(l => l.outcome === 'jwks_unavailable' && String(l.error).includes("not on the issuer's origin"))).toBe(true);
      expect(fetched).toEqual([`${KEYS}/.well-known/openid-configuration`]);
      v.stop();
    }
  });

  it('control: unset fetches from the issuer itself, as today', async () => {
    const { v, fetched } = await verifierWith(() => ({ issuer: ISS, jwks_uri: `${ISS}/jwks` }), null);
    expect(v.ready()).toBe(true);
    expect(fetched).toEqual([`${ISS}/.well-known/openid-configuration`, `${ISS}/jwks`]);
    v.stop();
  });
});
