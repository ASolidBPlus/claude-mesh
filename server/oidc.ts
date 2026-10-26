/**
 * R-406 — log in with a standard OAuth 2.0 access token (an RFC 9068 JWT)
 * from a configured OIDC issuer. Off unless configured.
 *
 * What a token must be, all checked here:
 *   - signed by a key in the issuer's JWKS (RFC 7517), found through its
 *     discovery document (OIDC Discovery / RFC 8414) fetched over the pinned
 *     MESH_OIDC_CA_FILE only — or, for a mesh that runs alone, a local
 *     MESH_OIDC_JWKS_FILE through the same verifier. With MESH_OIDC_KEYS_URL
 *     both are fetched from that internal base instead of the issuer's public
 *     origin (whose rotating certificate can't be pinned): the document must
 *     still name the public issuer, and its jwks_uri the issuer's origin;
 *   - header `typ: at+jwt`, an asymmetric algorithm (RS256 or ES256, never
 *     `none` or HS*), and a `kid` that is in the JWKS;
 *   - `iss` exactly the issuer, `aud` containing MESH_OIDC_AUDIENCE, `exp`
 *     (and `nbf`) within a small fixed skew;
 *   - an identity claim (preferred_username, or `sub` by MESH_OIDC_ID_CLAIM)
 *     that is a valid mesh agent id, and a `sub` (RFC 9068 requires one; an
 *     agent's name is bound to it, token-auth.ts);
 *   - an agent's own token: no `act` (not delegated), and `client_id` equal
 *     to the identity (W-1514 M9);
 *   - signed by a key from a key set at most JWKS_MAX_AGE_MS old, or, while
 *     the issuer is unreachable, at most JWKS_STALE_LIMIT_MS (W-1514 M7).
 *
 * The admin API takes a token from the same issuer for a second audience,
 * MESH_OIDC_ADMIN_AUDIENCE (`verifyAdmin`): same keys, same checks, its
 * caller named by `sub`, and what it may do by its `scope` claim.
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
/**
 * W-1514 M7: a key set older than this is refetched before it is trusted
 * again, so a key the issuer drops stops verifying within minutes.
 */
export const JWKS_MAX_AGE_MS = 5 * 60_000;
/**
 * While the issuer can't be reached, a stale key set keeps verifying for at
 * most this long after its last successful load; after that, every token is
 * OIDC_NOT_READY until a refetch succeeds.
 */
export const JWKS_STALE_LIMIT_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface OidcConfig {
  issuer: string;
  audience: string;
  idClaim: 'preferred_username' | 'sub';
  /** Discovery over this CA, or null when a local JWKS file is used instead. */
  caFile: string | null;
  jwksFile: string | null;
  /**
   * MESH_OIDC_KEYS_URL: an internal https base that serves the issuer's
   * discovery document and JWKS, or null to fetch them from the issuer itself.
   */
  keysUrl?: string | null;
  /** MESH_OIDC_ADMIN_AUDIENCE: the admin API's audience, or null (no admin tokens). */
  adminAudience?: string | null;
}

export interface TokenAuthConfig {
  oidc: OidcConfig | null;
  /** MESH_STATIC_TOKENS: per-agent tokens accepted (the default) or not. */
  staticTokens: boolean;
  /** MESH_ADMIN_STATIC_TOKEN: MESH_ADMIN_TOKEN (and _PREV) accepted (the default) or not. */
  adminStaticToken: boolean;
  /** MESH_METRICS_STATIC_TOKEN: MESH_METRICS_TOKEN accepted (the default) or not. */
  metricsStaticToken: boolean;
}

export type ConfigParse = { ok: true; config: TokenAuthConfig } | { ok: false; error: string };

/**
 * The only settings: MESH_OIDC_ISSUER, MESH_OIDC_AUDIENCE, MESH_OIDC_CA_FILE,
 * MESH_OIDC_ID_CLAIM, MESH_OIDC_JWKS_FILE, MESH_OIDC_ADMIN_AUDIENCE, and the
 * switches MESH_STATIC_TOKENS, MESH_ADMIN_STATIC_TOKEN and
 * MESH_METRICS_STATIC_TOKEN. All unset is exactly today. Half a configuration,
 * a file that can't be read, or a switch that would leave nobody able to get
 * in refuses to start.
 */
export function parseTokenAuthConfig(env: Record<string, string | undefined>): ConfigParse {
  const v = (k: string) => { const s = env[k]; return s === undefined || s === '' ? null : s; };
  const issuer = v('MESH_OIDC_ISSUER');
  const audience = v('MESH_OIDC_AUDIENCE');
  const caFile = v('MESH_OIDC_CA_FILE');
  const jwksFile = v('MESH_OIDC_JWKS_FILE');
  const idClaimRaw = v('MESH_OIDC_ID_CLAIM');
  const adminAudience = v('MESH_OIDC_ADMIN_AUDIENCE');
  const keysUrl = v('MESH_OIDC_KEYS_URL');

  const switches: Record<string, boolean> = {};
  for (const name of ['MESH_STATIC_TOKENS', 'MESH_ADMIN_STATIC_TOKEN', 'MESH_METRICS_STATIC_TOKEN']) {
    const raw = v(name);
    if (raw !== null && raw !== 'on' && raw !== 'off') return { ok: false, error: `${name} must be "on" or "off", got "${raw}"` };
    switches[name] = raw !== 'off';
  }
  const staticTokens = switches.MESH_STATIC_TOKENS!;
  const adminStaticToken = switches.MESH_ADMIN_STATIC_TOKEN!;
  const metricsStaticToken = switches.MESH_METRICS_STATIC_TOKEN!;
  // An off switch with nothing in its place locks everyone out of that door.
  if (adminAudience === null && !adminStaticToken) return { ok: false, error: 'MESH_ADMIN_STATIC_TOKEN=off with no MESH_OIDC_ADMIN_AUDIENCE: nobody could use the admin API' };
  if (adminAudience === null && !metricsStaticToken) return { ok: false, error: 'MESH_METRICS_STATIC_TOKEN=off with no MESH_OIDC_ADMIN_AUDIENCE: nobody could scrape /metrics' };

  if (issuer === null && audience === null && caFile === null && jwksFile === null && idClaimRaw === null && adminAudience === null && keysUrl === null) {
    if (!staticTokens) return { ok: false, error: 'MESH_STATIC_TOKENS=off with no MESH_OIDC_ISSUER: no agent could log in' };
    return { ok: true, config: { oidc: null, staticTokens, adminStaticToken, metricsStaticToken } };
  }
  if (issuer === null) return { ok: false, error: 'MESH_OIDC_* is partly set but MESH_OIDC_ISSUER is not' };
  if (audience === null) return { ok: false, error: 'MESH_OIDC_ISSUER is set but MESH_OIDC_AUDIENCE is not' };
  // Distinct, so an agent's login token can never be an admin credential.
  if (adminAudience === audience) return { ok: false, error: 'MESH_OIDC_ADMIN_AUDIENCE must differ from MESH_OIDC_AUDIENCE' };
  let url: URL;
  try { url = new URL(issuer); } catch { return { ok: false, error: 'MESH_OIDC_ISSUER is not a URL' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'MESH_OIDC_ISSUER must be https' };
  if (idClaimRaw !== null && idClaimRaw !== 'preferred_username' && idClaimRaw !== 'sub') {
    return { ok: false, error: 'MESH_OIDC_ID_CLAIM must be "preferred_username" or "sub"' };
  }
  if (keysUrl !== null) {
    let k: URL;
    try { k = new URL(keysUrl); } catch { return { ok: false, error: 'MESH_OIDC_KEYS_URL is not a URL' }; }
    if (k.protocol !== 'https:') return { ok: false, error: 'MESH_OIDC_KEYS_URL must be https' };
    if (jwksFile !== null) return { ok: false, error: 'MESH_OIDC_KEYS_URL is for discovery; it can\'t be used with MESH_OIDC_JWKS_FILE' };
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
  // W-1514 L12: with OIDC on, which static tokens still work is said, not
  // defaulted, so a switch-on can't leave one on by omission.
  const unset = ['MESH_STATIC_TOKENS', 'MESH_ADMIN_STATIC_TOKEN', 'MESH_METRICS_STATIC_TOKEN'].filter((name) => v(name) === null);
  if (unset.length > 0) return { ok: false, error: `MESH_OIDC_ISSUER is set, so ${unset.join(', ')} must each be set to "on" or "off"` };
  return {
    ok: true,
    config: {
      oidc: { issuer, audience, idClaim: idClaimRaw ?? 'preferred_username', caFile: jwksFile === null ? caFile : null, jwksFile, keysUrl, adminAudience },
      staticTokens, adminStaticToken, metricsStaticToken,
    },
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
  | 'WRONG_ISSUER' | 'WRONG_AUDIENCE' | 'EXPIRED' | 'NOT_YET_VALID' | 'NO_IDENTITY' | 'BAD_IDENTITY' | 'NO_SUB'
  | 'ADMIN_OFF' | 'ACTOR_TOKEN' | 'CLIENT_MISMATCH';

export type OidcResult = { ok: true; identity: string; sub: string; exp: number } | { ok: false; reason: OidcRefusal; claimed: string | null };

/** An admin token: who (`sub`) and what it may do (`scope`, RFC 9068 §2.2.3). */
export type OidcAdminResult = { ok: true; sub: string; scopes: ReadonlySet<string>; exp: number } | { ok: false; reason: OidcRefusal; claimed: string | null };

/** Longest `sub` kept, for a log line or a binding. */
const SUB_MAX = 256;

/**
 * `scope` as RFC 9068 and RFC 8693 carry it: one string, space-separated. Any
 * other shape (absent, an array, a number) is no scopes at all, so it grants
 * nothing.
 */
export function scopesOf(payload: JWTPayload): ReadonlySet<string> {
  const raw = payload.scope;
  if (typeof raw !== 'string') return new Set();
  return new Set(raw.split(' ').filter((s) => s !== ''));
}

/** A compact JWS shape: three base64url parts. Static mesh tokens are hex, so never match. */
export const looksLikeJwt = (t: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t);

export interface OidcVerifier {
  readonly issuer: string;
  /** MESH_OIDC_ADMIN_AUDIENCE, or null: admin access tokens are not accepted. */
  readonly adminAudience: string | null;
  /** True once a JWKS has loaded; until then every token is OIDC_NOT_READY. */
  ready(): boolean;
  verify(token: string): Promise<OidcResult>;
  /** The same checks against MESH_OIDC_ADMIN_AUDIENCE; ADMIN_OFF when it is unset. */
  verifyAdmin(token: string): Promise<OidcAdminResult>;
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
  /** When the key set in use was loaded (M7: its age). */
  let loadedAt = 0;
  let inflight: Promise<void> | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const install = (jwks: JSONWebKeySet) => {
    keys = createLocalJWKSet(jwks);
    kids = new Set(jwks.keys.map((k) => k.kid).filter((k): k is string => typeof k === 'string'));
    loadedAt = now();
  };

  const getJson = async (url: string): Promise<unknown> => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(ca === null ? {} : { tls: { ca } }) } as RequestInit);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  };

  /** Discovery, then the JWKS it names. Both over the pinned CA. */
  const keysUrl = config.keysUrl ?? null;
  const keysBase = (keysUrl ?? config.issuer).replace(/\/$/, '');
  const fetchKeys = async (): Promise<void> => {
    lastFetch = now();
    const disco = (await getJson(`${keysBase}/.well-known/openid-configuration`)) as { issuer?: unknown; jwks_uri?: unknown };
    if (disco.issuer !== config.issuer) throw new Error('the discovery document names a different issuer');
    if (typeof disco.jwks_uri !== 'string' || !disco.jwks_uri.startsWith('https://')) throw new Error('the discovery document has no https jwks_uri');
    let jwksUrl = disco.jwks_uri;
    if (keysUrl !== null) {
      // The document names the public URL; the keys come from the same path
      // (and query) on the internal base, never from the public origin.
      let u: URL;
      try { u = new URL(disco.jwks_uri); } catch { throw new Error('the discovery document\'s jwks_uri is not a URL'); }
      if (u.origin !== new URL(config.issuer).origin) throw new Error('the discovery document\'s jwks_uri is not on the issuer\'s origin');
      jwksUrl = `${keysBase}${u.pathname}${u.search}`;
    }
    const jwks = await getJson(jwksUrl);
    if (parseJwks(JSON.stringify(jwks)) === null) throw new Error('jwks_uri did not answer a JWKS');
    install(jwks as JSONWebKeySet);
    log({ outcome: 'jwks_loaded', issuer: config.issuer, keys: kids.size });
  };
  /** One refetch at a time, however many verifies want it. */
  const refetch = (): Promise<void> => (inflight ??= fetchKeys().finally(() => { inflight = null; }));

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

  const claimedOf = (token: string, claim: string): string | null => {
    try {
      const v = decodeJwt(token)[claim];
      return typeof v === 'string' ? v.slice(0, 128) : null;
    } catch { return null; }
  };

  /** Signature, header and registered claims for one audience: the payload, or why not. */
  const check = async (token: string, audience: string): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: OidcRefusal }> => {
    const no = (reason: OidcRefusal) => ({ ok: false as const, reason });
    if (keys === null) return no('OIDC_NOT_READY');
    // W-1514 M7: a key set past its maximum age is refetched first (at most
    // once a minute while that fails), so a key the issuer has dropped stops
    // verifying. If the issuer can't be reached the cached set is kept, but
    // only up to JWKS_STALE_LIMIT_MS after its last good load.
    if (config.jwksFile === null && now() - loadedAt > JWKS_MAX_AGE_MS) {
      // A verify that arrives while a refetch is running waits for it, rather
      // than trusting the set that refetch may be about to drop a key from.
      if (inflight !== null) {
        try { await inflight; } catch { /* logged by the caller that started it */ }
      } else if (now() - lastFetch >= JWKS_REFETCH_MIN_MS) {
        try { await refetch(); } catch (err) { log({ outcome: 'jwks_stale_refetch_failed', error: (err as Error).message, age_ms: now() - loadedAt }); }
      }
      if (now() - loadedAt > JWKS_STALE_LIMIT_MS) return no('OIDC_NOT_READY');
    }
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
        try { await refetch(); } catch (err) { log({ outcome: 'jwks_refetch_failed', error: (err as Error).message }); }
      }
      if (!kids.has(header.kid)) return no('UNKNOWN_KID');
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience,
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
    return { ok: true, payload };
  };

  const subOf = (payload: JWTPayload): string | null =>
    typeof payload.sub === 'string' && payload.sub !== '' && payload.sub.length <= SUB_MAX ? payload.sub : null;

  const verify = async (token: string): Promise<OidcResult> => {
    const claimed = claimedOf(token, config.idClaim);
    const c = await check(token, config.audience);
    if (!c.ok) return { ok: false, reason: c.reason, claimed };
    const { payload } = c;
    const identity = payload[config.idClaim];
    if (typeof identity !== 'string' || identity === '') return { ok: false, reason: 'NO_IDENTITY', claimed };
    // The mesh's id grammar, which has no `+` or `:`: an identity can't name
    // an alias or a remote address.
    if (!LOCAL_ID_RE.test(identity)) return { ok: false, reason: 'BAD_IDENTITY', claimed };
    const sub = subOf(payload);
    if (sub === null) return { ok: false, reason: 'NO_SUB', claimed };
    // W-1514 M9: an agent's own token only. A delegated (token-exchange) token
    // names an actor (RFC 8693 `act`), and an agent's client_credentials token
    // has its client id equal to its identity; anything else (a person's
    // exchanged token, another service's token) is not an agent login.
    if (payload.act !== undefined) return { ok: false, reason: 'ACTOR_TOKEN', claimed };
    if (payload.client_id !== identity) return { ok: false, reason: 'CLIENT_MISMATCH', claimed };
    return { ok: true, identity, sub, exp: payload.exp! };
  };

  const adminAudience = config.adminAudience ?? null;
  const verifyAdmin = async (token: string): Promise<OidcAdminResult> => {
    const claimed = claimedOf(token, 'sub');
    if (adminAudience === null) return { ok: false, reason: 'ADMIN_OFF', claimed };
    const c = await check(token, adminAudience);
    if (!c.ok) return { ok: false, reason: c.reason, claimed };
    const sub = subOf(c.payload);
    if (sub === null) return { ok: false, reason: 'NO_SUB', claimed };
    return { ok: true, sub, scopes: scopesOf(c.payload), exp: c.payload.exp! };
  };

  return {
    issuer: config.issuer,
    adminAudience,
    ready: () => keys !== null,
    verify,
    verifyAdmin,
    stop: () => { stopped = true; if (retryTimer !== null) clearTimeout(retryTimer); },
  };
}
