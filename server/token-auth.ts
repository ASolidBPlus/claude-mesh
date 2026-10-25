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
 * first valid login, and an agent's first OIDC login binds its name to the
 * token's `sub`: a later token naming the agent but carrying another `sub` is
 * refused (SUB_MISMATCH), so a renamed or reused name in the issuer can't take
 * over a mesh identity.
 */
import type { Database } from 'bun:sqlite';
import { generateToken, hashToken } from './auth.ts';
import { RESERVED_ALIAS, agentIdRefusal, bindOidcSub, getAgentById, getAgentByToken, getLivePeerKeyForAlias, getPeerByAlias, registerAgent } from './db.ts';
import { looksLikeJwt, type OidcRefusal, type OidcVerifier } from './oidc.ts';

export interface TokenAuth {
  oidc: OidcVerifier | null;
  staticTokens: boolean;
}

/** Today's behaviour: static tokens only. */
export const STATIC_ONLY: TokenAuth = { oidc: null, staticTokens: true };

export type AgentAuthResult =
  | { ok: true; agentId: string; via: 'static' | 'oidc'; exp: number | null; created: boolean }
  | { ok: false; reason: OidcRefusal | 'OIDC_OFF' | 'STATIC_TOKENS_OFF' | 'UNKNOWN_TOKEN' | 'IDENTITY_UNAVAILABLE' | 'SUB_MISMATCH'; claimed: string | null };

export const isOidcToken = (token: string) => looksLikeJwt(token);

/**
 * Verify a JWT and make sure its identity is an agent here. The token itself
 * is never logged by anything this calls.
 */
export async function authenticateJwt(db: Database, token: string, auth: TokenAuth): Promise<AgentAuthResult> {
  if (auth.oidc === null) return { ok: false, reason: 'OIDC_OFF', claimed: null };
  const v = await auth.oidc.verify(token);
  if (!v.ok) return { ok: false, reason: v.reason, claimed: v.claimed };
  if (getAgentById(db, v.identity) !== null) {
    if (!bindOidcSub(db, v.identity, v.sub)) return { ok: false, reason: 'SUB_MISMATCH', claimed: v.identity };
    return { ok: true, agentId: v.identity, via: 'oidc', exp: v.exp, created: false };
  }
  // First login: registration's rules for a new id (handleAgentPost), and no
  // token anyone holds. The hash is of a random value thrown away at once, so
  // the agent's only way in is the issuer.
  if (agentIdRefusal(v.identity) !== null) return { ok: false, reason: 'BAD_IDENTITY', claimed: v.identity };
  if (v.identity === RESERVED_ALIAS || getPeerByAlias(db, v.identity) !== null || getLivePeerKeyForAlias(db, v.identity, Date.now()) !== null) {
    return { ok: false, reason: 'IDENTITY_UNAVAILABLE', claimed: v.identity };
  }
  registerAgent(db, { id: v.identity, token_hash: hashToken(generateToken()), hostname: `claude-${v.identity}` });
  bindOidcSub(db, v.identity, v.sub);
  console.log(JSON.stringify({ evt: 'agent.registered', agent_id: v.identity, via: 'oidc', at: Date.now() }));
  return { ok: true, agentId: v.identity, via: 'oidc', exp: v.exp, created: true };
}

/** Any agent credential presented to an HTTP door. */
export async function authenticateAgentCredential(db: Database, token: string, auth: TokenAuth): Promise<AgentAuthResult> {
  if (isOidcToken(token)) return authenticateJwt(db, token, auth);
  if (!auth.staticTokens) return { ok: false, reason: 'STATIC_TOKENS_OFF', claimed: null };
  const agent = getAgentByToken(db, token);
  return agent === null ? { ok: false, reason: 'UNKNOWN_TOKEN', claimed: null } : { ok: true, agentId: agent.id, via: 'static', exp: null, created: false };
}
