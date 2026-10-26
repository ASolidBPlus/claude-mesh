/**
 * R-406 — the one place an agent credential is turned into an agent, for
 * every door that takes one: WS auth (ws-server), the agent-token routes on
 * the admin port (http-admin -> admin-ctx) and on the agent port (ws-server's
 * agent door). The admin token is never handled here.
 *
 * A credential is either a per-agent static token (hex, looked up by hash, as
 * always) or an OIDC access token (a JWT, verified by oidc.ts). Static tokens
 * can be switched off (MESH_STATIC_TOKENS=off); a JWT is refused unless OIDC
 * is configured. An OIDC identity that isn't on the mesh yet is created on its
 * first valid login and bound to the token's `sub`. An existing agent logs in
 * by OIDC only once an admin has bound it (W-1514 H3): unbound is refused
 * (OIDC_UNBOUND), and a different `sub` is refused (SUB_MISMATCH), so a row
 * that predates OIDC, or a name renamed or reused in the issuer, can't be
 * taken over.
 */
import type { Database } from 'bun:sqlite';
import { generateToken, hashToken } from './auth.ts';
import { RESERVED_ALIAS, agentIdRefusal, oidcSubState, setOidcSub, getAgentByToken, getLivePeerKeyForAlias, getPeerByAlias, registerAgent } from './db.ts';
import { looksLikeJwt, type OidcRefusal, type OidcVerifier } from './oidc.ts';

export interface TokenAuth {
  oidc: OidcVerifier | null;
  staticTokens: boolean;
}

/** Today's behaviour: static tokens only. */
export const STATIC_ONLY: TokenAuth = { oidc: null, staticTokens: true };

export type AgentAuthResult =
  | { ok: true; agentId: string; via: 'static' | 'oidc'; exp: number | null; created: boolean }
  | { ok: false; reason: OidcRefusal | 'OIDC_OFF' | 'STATIC_TOKENS_OFF' | 'UNKNOWN_TOKEN' | 'IDENTITY_UNAVAILABLE' | 'SUB_MISMATCH' | 'OIDC_UNBOUND'; claimed: string | null };

export const isOidcToken = (token: string) => looksLikeJwt(token);

/**
 * Verify a JWT and make sure its identity is an agent here. The token itself
 * is never logged by anything this calls.
 */
export async function authenticateJwt(db: Database, token: string, auth: TokenAuth): Promise<AgentAuthResult> {
  if (auth.oidc === null) return { ok: false, reason: 'OIDC_OFF', claimed: null };
  const v = await auth.oidc.verify(token);
  if (!v.ok) return { ok: false, reason: v.reason, claimed: v.claimed };
  const binding = subRefusal(db, v.identity, v.sub);
  if (binding !== 'missing') {
    if (binding !== null) return { ok: false, reason: binding, claimed: v.identity };
    return { ok: true, agentId: v.identity, via: 'oidc', exp: v.exp, created: false };
  }
  // First login: registration's rules for a new id (handleAgentPost), and no
  // token anyone holds. The hash is of a random value thrown away at once, so
  // the agent's only way in is the issuer.
  if (agentIdRefusal(v.identity) !== null) return { ok: false, reason: 'BAD_IDENTITY', claimed: v.identity };
  if (v.identity === RESERVED_ALIAS || getPeerByAlias(db, v.identity) !== null || getLivePeerKeyForAlias(db, v.identity, Date.now()) !== null) {
    return { ok: false, reason: 'IDENTITY_UNAVAILABLE', claimed: v.identity };
  }
  db.transaction(() => {
    registerAgent(db, { id: v.identity, token_hash: hashToken(generateToken()), hostname: `claude-${v.identity}` });
    setOidcSub(db, v.identity, v.sub);
  })();
  console.log(JSON.stringify({ evt: 'agent.registered', agent_id: v.identity, via: 'oidc', at: Date.now() }));
  return { ok: true, agentId: v.identity, via: 'oidc', exp: v.exp, created: true };
}

/**
 * Why an OIDC login (or re-auth, ws-server) as `id` with `sub` is refused, or
 * null when the row is bound to that `sub`; 'missing' when there is no row.
 */
export function subRefusal(db: Database, id: string, sub: string): 'SUB_MISMATCH' | 'OIDC_UNBOUND' | 'missing' | null {
  const state = oidcSubState(db, id, sub);
  return state === 'bound' ? null : state === 'unbound' ? 'OIDC_UNBOUND' : state === 'mismatch' ? 'SUB_MISMATCH' : 'missing';
}

/** Any agent credential presented to an HTTP door. */
export async function authenticateAgentCredential(db: Database, token: string, auth: TokenAuth): Promise<AgentAuthResult> {
  if (isOidcToken(token)) return authenticateJwt(db, token, auth);
  if (!auth.staticTokens) return { ok: false, reason: 'STATIC_TOKENS_OFF', claimed: null };
  const agent = getAgentByToken(db, token);
  return agent === null ? { ok: false, reason: 'UNKNOWN_TOKEN', claimed: null } : { ok: true, agentId: agent.id, via: 'static', exp: null, created: false };
}
