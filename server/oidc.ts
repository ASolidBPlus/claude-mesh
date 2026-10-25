/**
 * R-406 — log in with a standard OAuth 2.0 access token (an RFC 9068 JWT)
 * from a configured OIDC issuer. Off unless configured.
 *
 * What a token must be, all checked here:
 *   - signed by a key in the issuer's JWKS (RFC 7517), found through its
 *     discovery document (OIDC Discovery / RFC 8414) fetched over the pinned
 *     MESH_OIDC_CA_FILE only — or, for a mesh that runs alone, a local
 *     MESH_OIDC_JWKS_FILE through the same verifier;
 *   - header `typ: at+jwt`, an asymmetric algorithm (RS256 or ES256, never
 *     `none` or HS*), and a `kid` that is in the JWKS;
 *   - `iss` exactly the issuer, `aud` containing MESH_OIDC_AUDIENCE, `exp`
 *     (and `nbf`) within a small fixed skew;
 *   - an identity claim (preferred_username, or `sub` by MESH_OIDC_ID_CLAIM)
 *     that is a valid mesh agent id.
 *
 * jose does the JOSE work (signature, algorithms, claims); this module decides
 * which issuer, which keys and which identity, and turns every refusal into a
 * stable reason code for the log. Nothing here logs a token.
 */
import { readFileSync } from 'fs';
import { createLocalJWKSet, decodeJwt, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { LOCAL_ID_RE } from './db.ts';

export const OIDC_ALGORITHMS = ['RS256', 'ES256'] as const;
export const OIDC_CLOCK_SKEW_S = 30;
/** An unknown `kid` refetches the JWKS at most this often. */
export const JWKS_REFETCH_MIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface OidcConfig {
  issuer: string;
  audience: string;
  idClaim: 'preferred_username' | 'sub';
  /** Discovery over this CA, or null when a local JWKS file is used instead. */
  caFile: string | null;
  jwksFile: string | null;
}

export interface TokenAuthConfig {
  oidc: OidcConfig | null;
  /** MESH_STATIC_TOKENS: per-agent tokens accepted (the default) or not. */
  staticTokens: boolean;
}

export type ConfigParse = { ok: true; config: TokenAuthConfig } | { ok: false; error: string };

/**
 * The only settings: MESH_OIDC_ISSUER, MESH_OIDC_AUDIENCE, MESH_OIDC_CA_FILE,
 * MESH_OIDC_ID_CLAIM, MESH_OIDC_JWKS_FILE and MESH_STATIC_TOKENS. All unset is
 * exactly today. Half a configuration, or a file that can't be read, refuses
 * to start.
 */
export function parseTokenAuthConfig(env: Record<string, string | undefined>): ConfigParse {
  const v = (k: string) => { const s = env[k]; return s === undefined || s === '' ? null : s; };
  const issuer = v('MESH_OIDC_ISSUER');
  const audience = v('MESH_OIDC_AUDIENCE');
  const caFile = v('MESH_OIDC_CA_FILE');
  const jwksFile = v('MESH_OIDC_JWKS_FILE');
  const idClaimRaw = v('MESH_OIDC_ID_CLAIM');
  const staticRaw = v('MESH_STATIC_TOKENS');

  if (staticRaw !== null && staticRaw !== 'on' && staticRaw !== 'off') return { ok: false, error: `MESH_STATIC_TOKENS must be "on" or "off", got "${staticRaw}"` };
  const staticTokens = staticRaw !== 'off';

  if (issuer === null && audience === null && caFile === null && jwksFile === null && idClaimRaw === null) {
    if (!staticTokens) return { ok: false, error: 'MESH_STATIC_TOKENS=off with no MESH_OIDC_ISSUER: no agent could log in' };
    return { ok: true, config: { oidc: null, staticTokens } };
  }
  if (issuer === null) return { ok: false, error: 'MESH_OIDC_* is partly set but MESH_OIDC_ISSUER is not' };
  if (audience === null) return { ok: false, error: 'MESH_OIDC_ISSUER is set but MESH_OIDC_AUDIENCE is not' };
  let url: URL;
  try { url = new URL(issuer); } catch { return { ok: false, error: 'MESH_OIDC_ISSUER is not a URL' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'MESH_OIDC_ISSUER must be https' };
  if (idClaimRaw !== null && idClaimRaw !== 'preferred_username' && idClaimRaw !== 'sub') {
    return { ok: false, error: 'MESH_OIDC_ID_CLAIM must be "preferred_username" or "sub"' };
  }
  if (jwksFile === null && caFile === null) return { ok: false, error: 'MESH_OIDC_ISSUER needs MESH_OIDC_CA_FILE (discovery over the pinned CA), or MESH_OIDC_JWKS_FILE for a local JWKS' };
  for (const [name, file] of [['MESH_OIDC_CA_FILE', caFile], ['MESH_OIDC_JWKS_FILE', jwksFile]] as const) {
    if (file === null) continue;
    try { readFileSync(file); } catch (err) { return { ok: false, error: `${name} can't be read: ${(err as Error).message}` }; }
  }
  if (jwksFile !== null) {
    const parsed = parseJwks(readFileSync(jwksFile, 'utf8'));
    if (parsed === null) return { ok: false, error: 'MESH_OIDC_JWKS_FILE is not a JWKS ({"keys": [...]})' };
  }
  return {
    ok: true,
    config: { oidc: { issuer, audience, idClaim: idClaimRaw ?? 'preferred_username', caFile: jwksFile === null ? caFile : null, jwksFile }, staticTokens },
  };
}

function parseJwks(text: string): JSONWebKeySet | null {
  try {
    const doc = JSON.parse(text) as { keys?: unknown };
    return Array.isArray(doc.keys) ? (doc as JSONWebKeySet) : null;
  } catch {
    return null;
  }
}

/** Why a token was refused: stable codes for the log, never the token. */
export type OidcRefusal =
  | 'OIDC_NOT_READY' | 'MALFORMED' | 'WRONG_TYP' | 'BAD_ALG' | 'NO_KID' | 'UNKNOWN_KID' | 'BAD_SIGNATURE'
  | 'WRONG_ISSUER' | 'WRONG_AUDIENCE' | 'EXPIRED' | 'NOT_YET_VALID' | 'NO_IDENTITY' | 'BAD_IDENTITY';

export type OidcResult = { ok: true; identity: string; exp: number } | { ok: false; reason: OidcRefusal; claimed: string | null };

/** A compact JWS shape: three base64url parts. Static mesh tokens are hex, so never match. */
export const looksLikeJwt = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t);

export interface OidcVerifier {
  readonly issuer: string;
  /** True once a JWKS has loaded; until then every token is OIDC_NOT_READY. */
  ready(): boolean;
  verify(token: string): Promise<OidcResult>;
  stop(): void;
}

/**
 * The verifier. With discovery, the first load runs in the background and
 * retries with backoff: an issuer that is down at boot never stops the mesh,
 * it only refuses OIDC logins until the keys load (static tokens are
 * unaffected). `fetchImpl` and `now` are seams for tests.
 */
export function createOidcVerifier(
  config: OidcConfig,
  deps: { fetchImpl?: typeof fetch; now?: () => number; log?: (fields: Record<string, unknown>) => void } = {},
): OidcVerifier {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((f) => console.log(JSON.stringify({ evt: 'oidc', ...f, at: Date.now() })));
  const ca = config.caFile === null ? null : readFileSync(config.caFile, 'utf8');
  let keys: ReturnType<typeof createLocalJWKSet> | null = null;
  let kids = new Set<string>();
  let lastFetch = 0;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const install = (jwks: JSONWebKeySet) => {
    keys = createLocalJWKSet(jwks);
    kids = new Set(jwks.keys.map((k) => k.kid).filter((k): k is string => typeof k === 'string'));
  };

  const getJson = async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(ca === null ? {} : { tls: { ca } }) } as RequestInit);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  };

  /** Discovery, then the JWKS it names. Both over the pinned CA. */
  const fetchKeys = async (): Promise<void> => {
    lastFetch = now();
    const disco = (await getJson(`${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)) as { issuer?: unknown; jwks_uri?: unknown };
    if (disco.issuer !== config.issuer) throw new Error('the discovery document names a different issuer');
    if (typeof disco.jwks_uri !== 'string' || !disco.jwks_uri.startsWith('https://')) throw new Error('the discovery document has no https jwks_uri');
    const jwks = await getJson(disco.jwks_uri);
    if (parseJwks(JSON.stringify(jwks)) === null) throw new Error('jwks_uri did not answer a JWKS');
    install(jwks as JSONWebKeySet);
    log({ outcome: 'jwks_loaded', issuer: config.issuer, keys: kids.size });
  };

  if (config.jwksFile !== null) {
    install(parseJwks(readFileSync(config.jwksFile, 'utf8'))!);
    log({ outcome: 'jwks_loaded', issuer: config.issuer, keys: kids.size, source: 'file' });
  } else {
    let delay = 1_000;
    const attempt = () => {
      if (stopped) return;
      fetchKeys().catch((err) => {
        log({ outcome: 'jwks_unavailable', issuer: config.issuer, error: (err as Error).message, retry_ms: delay });
        retryTimer = setTimeout(attempt, delay);
        retryTimer.unref?.();
        delay = Math.min(delay * 2, 60_000);
      });
    };
    attempt();
  }

  const claimedOf = (token: string): string | null => {
    try {
      const v = decodeJwt(token)[config.idClaim];
      return typeof v === 'string' ? v.slice(0, 128) : null;
    } catch { return null; }
  };

  const verify = async (token: string): Promise<OidcResult> => {
    const claimed = claimedOf(token);
    const no = (reason: OidcRefusal): OidcResult => ({ ok: false, reason, claimed });
    if (keys === null) return no('OIDC_NOT_READY');
    let header: { alg?: unknown; kid?: unknown; typ?: unknown };
    try {
      header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as typeof header;
    } catch { return no('MALFORMED'); }
    if (!(OIDC_ALGORITHMS as readonly unknown[]).includes(header.alg)) return no('BAD_ALG');
    if (typeof header.kid !== 'string' || header.kid === '') return no('NO_KID');
    if (!kids.has(header.kid)) {
      // A rotated key: refetch, but at most once a minute, so a stream of
      // made-up kids can't make the mesh hammer the issuer.
      if (config.jwksFile === null && now() - lastFetch >= JWKS_REFETCH_MIN_MS) {
        try { await fetchKeys(); } catch (err) { log({ outcome: 'jwks_refetch_failed', error: (err as Error).message }); }
      }
      if (!kids.has(header.kid)) return no('UNKNOWN_KID');
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: [...OIDC_ALGORITHMS],
        typ: 'at+jwt',
        clockTolerance: OIDC_CLOCK_SKEW_S,
        requiredClaims: ['exp'],
        currentDate: new Date(now()),
      }));
    } catch (err) {
      if (err instanceof errors.JWTExpired) return no('EXPIRED');
      if (err instanceof errors.JWTClaimValidationFailed) {
        if (err.claim === 'iss') return no('WRONG_ISSUER');
        if (err.claim === 'aud') return no('WRONG_AUDIENCE');
        if (err.claim === 'nbf') return no('NOT_YET_VALID');
        if (err.claim === 'typ') return no('WRONG_TYP');
        if (err.claim === 'exp') return no('EXPIRED');
        return no('MALFORMED');
      }
      if (err instanceof errors.JOSEAlgNotAllowed) return no('BAD_ALG');
      if (err instanceof errors.JWSSignatureVerificationFailed) return no('BAD_SIGNATURE');
      if (err instanceof errors.JWKSNoMatchingKey) return no('UNKNOWN_KID');
      return no('MALFORMED');
    }
    const identity = payload[config.idClaim];
    if (typeof identity !== 'string' || identity === '') return no('NO_IDENTITY');
    // The mesh's id grammar, which has no `+` or `:`: an identity can't name
    // an alias or a remote address.
    if (!LOCAL_ID_RE.test(identity)) return no('BAD_IDENTITY');
    return { ok: true, identity, exp: payload.exp! };
  };

  return {
    issuer: config.issuer,
    ready: () => keys !== null,
    verify,
    stop: () => { stopped = true; if (retryTimer !== null) clearTimeout(retryTimer); },
  };
}
