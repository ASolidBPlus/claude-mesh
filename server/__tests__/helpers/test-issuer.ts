// R-406 tests: a local OIDC issuer over HTTPS with its own CA, serving the
// discovery document and a JWKS, and a signer for access tokens (good and
// deliberately bad). Used by the server and SDK tests.
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface TestKey { kid: string; alg: 'RS256' | 'ES256'; privateKey: CryptoKey; jwk: JWK }

export async function makeKey(kid: string, alg: 'RS256' | 'ES256' = 'ES256'): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey: privateKey as CryptoKey, jwk };
}

/** A CA and a server certificate for 127.0.0.1, written into `dir`. */
export function makeCa(dir: string, name = 'ca'): { caPem: string; caFile: string; certFile: string; keyFile: string } {
  const run = (...a: string[]) => { const r = Bun.spawnSync(['openssl', ...a], { cwd: dir, stderr: 'pipe' }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=${name}`);
  run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}-srv.key`, '-out', `${name}-srv.csr`, '-subj', '/CN=issuer');
  writeFileSync(join(dir, `${name}-srv.ext`), 'subjectAltName=IP:127.0.0.1\n');
  run('x509', '-req', '-in', `${name}-srv.csr`, '-CA', `${name}.pem`, '-CAkey', `${name}.key`, '-CAcreateserial', '-out', `${name}-srv.pem`, '-days', '2', '-extfile', `${name}-srv.ext`);
  return { caPem: readFileSync(join(dir, `${name}.pem`), 'utf8'), caFile: join(dir, `${name}.pem`), certFile: join(dir, `${name}-srv.pem`), keyFile: join(dir, `${name}-srv.key`) };
}

export interface TestIssuer {
  url: string;
  port: number;
  keys: TestKey[];
  /** How many times the JWKS was fetched. */
  jwksFetches: () => number;
  setKeys: (keys: TestKey[]) => void;
  stop: () => void;
}

/** Serve discovery + JWKS over HTTPS. `issuerOverride` serves a discovery doc naming another issuer. */
export function startIssuer(port: number, tls: { certFile: string; keyFile: string }, keys: TestKey[], opts: { issuerOverride?: string } = {}): TestIssuer {
  const url = `https://127.0.0.1:${port}`;
  let current = keys;
  let fetches = 0;
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    tls: { cert: Bun.file(tls.certFile), key: Bun.file(tls.keyFile) },
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/.well-known/openid-configuration') return Response.json({ issuer: opts.issuerOverride ?? url, jwks_uri: `${url}/jwks` });
      if (path === '/jwks') { fetches++; return Response.json({ keys: current.map((k) => k.jwk) }); }
      return new Response('not found', { status: 404 });
    },
  });
  return { url, port, keys: current, jwksFetches: () => fetches, setKeys: (k) => { current = k; }, stop: () => server.stop(true) };
}

/** An RFC 9068 access token, with any part overridable for the negative tests. */
export async function accessToken(key: TestKey, claims: Record<string, unknown>, opts: { typ?: string; kid?: string | null; expIn?: number; nbfIn?: number } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: key.alg, typ: opts.typ ?? 'at+jwt', ...(opts.kid === null ? {} : { kid: opts.kid ?? key.kid }) })
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expIn ?? 300));
  if (opts.nbfIn !== undefined) jwt.setNotBefore(now + opts.nbfIn);
  return jwt.sign(key.privateKey);
}

/** A compact JWS with an arbitrary header and signature, for alg:none / HS256 forgeries. */
export function rawJws(header: Record<string, unknown>, payload: Record<string, unknown>, sig: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b(header)}.${b(payload)}.${sig}`;
}
