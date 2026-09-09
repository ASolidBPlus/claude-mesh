/**
 * #143 — The admin API's REQUEST CONTEXT: the types every handler shares, and the
authentication, body-reading and formatting helpers they all reach for.
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import { Database } from 'bun:sqlite';
import * as http from 'http';
import { WebSocket } from 'ws';
import {
  timingSafeEqual,
} from './auth.ts';
import {
  Agent, OutboundPeer, getAgentByToken,
} from './db.ts';
import {
  incAdminAuth,
} from './metrics.ts';

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

export function requireAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  adminToken: string
): boolean {
  // #79: the same helper every other door uses. This compared the WHOLE header
  // with `===` — a plain string comparison against a live credential, which is
  // both the weakest of the three behaviours this repo had and the one a reader
  // is most likely to copy, because it looks like ordinary code.
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    if (timingSafeEqual(auth.slice('Bearer '.length), adminToken)) {
      return true;
    }
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

/**
 * #161 — WHERE THE REQUEST CAME FROM, and how much that is worth.
 *
 * `remote` is the transport peer: the socket's own address, which cannot be
 * forged by the caller but IS the proxy's address whenever one is in front.
 *
 * `xff_untrusted` is `x-forwarded-for` verbatim, under a name that says what it
 * is. It is a REQUEST HEADER — anyone may send one, saying anything — so it is
 * recorded because it is occasionally the only way to see past a proxy, and
 * named so that nobody reads it as evidence. A field called `client_ip` would
 * be believed; this one has to be argued for.
 *
 * Neither is an identity. The admin credential is shared, so an address
 * narrows "which host" and never "which person" — the bound this whole feature
 * ships with.
 */
export function requestSource(req: http.IncomingMessage): Record<string, string | null> {
  const xff = req.headers['x-forwarded-for'];
  return {
    remote: req.socket.remoteAddress ?? null,
    // Truncated: a header is caller-controlled and unbounded, and an audit line
    // is not a place to let a caller write arbitrarily much.
    xff_untrusted: typeof xff === 'string' ? xff.slice(0, 256) : null,
  };
}

/**
 * WHY THE CREDENTIAL FAILED — for the LOG ONLY.
 *
 * C9 in its usual shape: distinct causes, one indistinguishable outcome on the
 * prober-reachable surface. The 401 body and status are identical for both
 * values here, and `mesh_admin_auth_total` carries no reason label because
 * `/metrics` is unauthenticated on this port. A structured log on the server is
 * not a surface an unauthenticated caller can read, which is what makes the
 * distinction safe to keep exactly here and nowhere else.
 *
 * Returns a CLASS, never any part of what was presented — 'invalid' means a
 * Bearer token was offered and did not match, and the bytes of that token are
 * not this function's to hand on. #144's rule: token bytes never reach a log,
 * a metric label, or a read API.
 *
 * NOT A TIMING CLAIM. `absent` short-circuits before any comparison, so the two
 * paths differ in duration; that is true on main today and this function does
 * not change it. The comparison itself is timing-safe (auth.ts timingSafeEqual);
 * the presence check is not, and is not pretended to be.
 */
export function credentialReason(req: http.IncomingMessage): 'absent' | 'invalid' {
  const header = req.headers['authorization'];
  return typeof header === 'string' && header.startsWith('Bearer ') ? 'invalid' : 'absent';
}

/**
 * ONE structured event per admin-authentication decision, success AND failure.
 *
 * Success mattered as much as failure here and was the half most likely to be
 * skipped: with only failures logged, a stolen token that works leaves exactly
 * as little trace as it did before, and the question the operator has —
 * "has anyone used the admin token?" — is answered by silence either way.
 *
 * THE PATH IS LOGGED WITHOUT ITS QUERY STRING. A path names the object; a query
 * is caller-controlled, unbounded, and not needed to say what was reached. The
 * path parameters in this API are object ids by construction (agent ids, key
 * ids, aliases) — never credentials, which arrive in headers and bodies.
 *
 * WHAT IT IS NOT: attribution. The admin token is shared between holders, so
 * this records that the credential was used and from where, never by whom. It
 * lands ALONGSIDE the token shed, not instead of it.
 */
export function recordAdminAuth(
  req: http.IncomingMessage,
  outcome: 'success' | 'failure',
  reason: 'absent' | 'invalid' | null,
  mode: NonNullable<Route['auth']> | 'admin',
): void {
  incAdminAuth(outcome);
  let path = req.url ?? '';
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  console.log(JSON.stringify({
    evt: 'admin.auth',
    outcome,
    reason,                                   // null on success; server-side only
    method: req.method ?? null,
    path,
    // A failure on an agentOrAdmin route may be a mistyped agent token rather
    // than an admin attempt. Stated, so the event is not read as a count of
    // admin attempts on those routes.
    route_admits_agents: mode === 'agentOrAdmin',
    ...requestSource(req),
    at: Date.now(),
  }));
}

// Result of authenticating a request on an agent-or-admin route.
// 'unauthenticated' exists so the dispatcher has an HONEST value for
// auth:'handler' routes, where by design it checks no credential. Representing
// "nobody checked" as { mode: 'admin' } would make admin the default
// inheritance for every future handler-authenticated route — and auth.mode ===
// 'admin' is a GRANT on the file path. A type that cannot say "unauthenticated"
// forces the dispatcher to lie.
//
// It is NEVER a grant. Every consumer must treat it as strictly less privileged
// than 'agent': no scope, no ownership, no admin.
/**
 * F2a: how the admin API starts and stops border forwarders.
 *
 * `create` is optional BY DESIGN. F2a declares the interface; F2b registers the
 * implementation. Until then `POST /outbound-peers` answers 503 and writes no
 * row, so main cannot reach the state where sends are accepted and acked for a
 * peering nothing will ever drain.
 */
export interface ForwarderRegistry {
  create?: (row: OutboundPeer) => void;
  stop?: (alias: string) => void;
}

export type AuthResult = { mode: 'admin' } | { mode: 'agent'; agentId: string } | { mode: 'unauthenticated' };

// Resolve auth for a route that accepts EITHER the admin token OR an agent's
// own bearer token. Admin is checked FIRST (exact, timing-safe) — if the token
// is the configured admin token the caller is admin; otherwise it is looked up
// as an agent token (SHA-256 hashed, then matched against agents.token_hash —
// the raw token is never byte-compared against a stored secret). Returns null
// and writes 401 when neither matches.
export function resolveAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database,
  adminToken: string
): AuthResult | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length);
    if (timingSafeEqual(token, adminToken)) {
      return { mode: 'admin' };
    }
    const agent = getAgentByToken(db, token);
    if (agent !== null) {
      return { mode: 'agent', agentId: agent.id };
    }
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return null;
}

export function formatAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    hostname: agent.hostname,
    online: agent.online === 1,
    capabilities: JSON.parse(agent.capabilities) as unknown[],
    metadata: JSON.parse(agent.metadata) as Record<string, unknown>,
    namespace: agent.namespace ?? null,
    registered_at: agent.registered_at,
    last_seen: agent.last_seen,
    last_alive: agent.last_alive ?? null,
    // #133: the LOOP's proof-of-life, beside the transport's. null until the
    // emitter ships (spawner#346) — a null is honest; a number that meant
    // something else is what this exists to stop.
    last_responded: agent.last_responded ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Route dispatch
//
// Each admin endpoint is a named handler taking a single AdminCtx. The ROUTES
// table below maps (method, path-matcher) -> handler and is matched
// top-to-bottom, first match wins — preserving the exact order/precedence of
// the original inline if-chain (notably exact `/agents` before `/agents/:id`,
// and no 405: a known path with an unsupported method simply falls through to
// the 404 at the end of dispatch).
// ──────────────────────────────────────────────────────────────────────────

export interface AdminCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  db: Database;
  url: URL;
  params: Record<string, string>;
  agentIndex: Map<string, WebSocket>;
  observerIndex: Map<string, WebSocket>;
  /** F1a: alias -> peer socket. Present so revocation and re-registration can
   *  close a live peer connection immediately. */
  peerIndex: Map<string, WebSocket>;
  /** F2a: the outbound forwarder registry. `create` is ABSENT until F2b
   *  registers it — which is what makes POST /outbound-peers refuse with 503
   *  and keeps the front half inert between the two merges. */
  forwarders: ForwarderRegistry;
  maxFileBytes: number;
  filesDir: string;
  // Authenticated caller. 'admin' for admin-token routes; for 'agentOrAdmin'
  // routes it is 'admin' or the specific agent. Handlers that don't scope by
  // caller ignore it.
  auth: AuthResult;
}

export type AdminHandler = (ctx: AdminCtx) => Promise<void> | void;

export interface Route {
  method: string;
  match: (pathname: string) => Record<string, string> | null;
  handler: AdminHandler;
  // 'admin' (default) requires the admin token; 'agentOrAdmin' also accepts an
  // agent's own bearer token (self-scoped in the handler).
  //   'handler' — the dispatcher applies NO credential check; the HANDLER must
  //   authenticate. Named for what the ROUTE's obligation is, not for what the
  //   dispatcher does. One route in F0b: POST /peers/register, by peer key,
  //   which is neither the admin token nor an agent token.
  auth?: 'admin' | 'agentOrAdmin' | 'handler';
}

// Path matchers: `exact` for a literal path, `idMatch` to capture a single
// `:id` segment into params.id.
export const exact = (p: string) => (pathname: string): Record<string, string> | null =>
  pathname === p ? {} : null;
export const idMatch = (re: RegExp) => (pathname: string): Record<string, string> | null => {
  const m = pathname.match(re);
  return m ? { id: m[1] as string } : null;
};

/**
 * The dispatcher's whole auth decision, in one place, keyed on the route's
 * declared mode. Returns null when it has already written a 401.
 *
 * Extracted so the 'handler' arm is TESTABLE. Left inline, a mutant restoring
 * the old { mode: 'admin' } placeholder passes every test and every typecheck:
 * the grant predicate is proven to refuse 'unauthenticated' while nothing
 * proves the dispatcher ever produces it.
 */
export function resolveRouteAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database,
  adminToken: string,
  mode: Route['auth'] | undefined
): AuthResult | null {
  if (mode === 'handler') {
    // No dispatcher-level credential BY DESIGN: this route's handler owns its
    // authentication and must refuse uniformly. The ctx says 'unauthenticated'
    // because that is the TRUTH here — the handler's own check is invisible to
    // the dispatcher, so nothing it hands the handler may act as a grant.
    //
    // #161: NOT recorded as an admin-auth outcome, because no admin credential
    // was required or examined. The one route in this mode (/peers/register)
    // logs its own refusals as `peer.register_refused`. Recording it here would
    // report an admin authentication that did not happen.
    return { mode: 'unauthenticated' };
  }
  if (mode === 'agentOrAdmin') {
    const result = resolveAuth(req, res, db, adminToken);
    // Only an ADMIN outcome on this route is an admin authentication. An agent
    // succeeding is not, and is not counted here.
    if (result !== null && result.mode === 'admin') {
      recordAdminAuth(req, 'success', null, mode);
    } else if (result === null) {
      // The credential was neither an admin token nor a live agent token. That
      // MAY have been a failed admin attempt and there is no way to tell —
      // said plainly in the event via `route_admits_agents`, so a reader does
      // not mistake this for a count of admin attempts.
      recordAdminAuth(req, 'failure', credentialReason(req), mode);
    }
    return result;
  }
  // 'admin' and the no-route case: unmatched paths still require the admin
  // token before the 404, so an unauthenticated caller cannot probe which
  // routes exist.
  if (!requireAdmin(req, res, adminToken)) {
    recordAdminAuth(req, 'failure', credentialReason(req), mode ?? 'admin');
    return null;
  }
  recordAdminAuth(req, 'success', null, mode ?? 'admin');
  return { mode: 'admin' };
}

// ─── Peer keys and peer registration (F0b — §3, §4, §6) ─────────────────────

/** Public shape of a peer key. NEVER includes key_hash: the mint response is
    the only time the secret exists, and a listing that leaked the hash would
    make every stored key offline-crackable from an admin-read alone. */
