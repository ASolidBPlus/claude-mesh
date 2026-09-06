import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
import { WebSocket } from 'ws';
import {
  getAgentById,
  getAgentByToken,
  aclGrant,
  aclRevoke,
  aclCheck,
  listInboundAcl,
  listOutboundAcl,
  listAclByGrantedBy,
  listAclByGrantedByPrefix,
  getOrCreateTopic,
  listTopics,
  listAgents,
  Agent,
  getFile,
  insertFile,
  markFileDelivered,
  deleteAgent,
  registerAgent,
  updateAgent,
  queryMessages,
  insertReminder,
  listAgentReminders,
  listAllReminders,
  getReminder,
  updateReminder,
  cancelReminder as dbCancelReminder,
  Reminder,
  grantObserver,
  revokeObserver,
  isObserver,
  listObservers,
} from './db.ts';
import { generateToken, hashToken, timingSafeEqual } from './auth.ts';
import {
  PEER_ALIAS_RE, RESERVED_ALIAS, insertPeerKey, listPeerKeys, getLivePeerKeyForAlias,
  getPeerKeyBySecret, revokePeerKey, getPeerByAlias, upsertPeer, getPeerKeyById, type PeerKey,
  insertOutboundPeer, getOutboundPeer, listOutboundPeers, updateOutboundPeer, endOutboundPeering, type OutboundPeer,
} from './db.ts';
// #131: read via ./wire-version.ts, never as a direct cross-package import
// from the client wire module.
//
// This file is 81,312 B — over the 51,200 B transpiler-cache threshold — and it
// was the ONLY importer that ever hit the intermittent link failure. It was
// also the only one both cached AND crossing the package boundary. The
// invariant, and the reason wire-version.ts exists, is written there.
//
// (Deliberately not naming the client path in prose here: a comment containing
// the literal import string makes this file register as a cross-package
// importer to any grep that does not strip comments, which is exactly the false
// positive that turned up while verifying the invariant.)
//
// The constant still has exactly ONE definition. That, and the specifier every
// reader uses, are pinned by border.test.ts, so the obvious tidy-up reds rather
// than silently reinstating the edge.
import { PEER_PROTOCOL_VERSION } from './wire-version.ts';
import { parseDuration } from './duration.ts';
import { cronValidate, cronNext, tzValidate, cronNextTz, isBareIso, bareIsoToUtc } from './cron.ts';
import { renderMetrics } from './metrics.ts';

export interface HttpAdminHandle {
  server: http.Server;
  shutdown(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function requireAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  adminToken: string
): boolean {
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${adminToken}`) {
    return true;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
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
function resolveAuth(
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

function formatAgent(agent: Agent): Record<string, unknown> {
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

interface AdminCtx {
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

type AdminHandler = (ctx: AdminCtx) => Promise<void> | void;

interface Route {
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
const exact = (p: string) => (pathname: string): Record<string, string> | null =>
  pathname === p ? {} : null;
const idMatch = (re: RegExp) => (pathname: string): Record<string, string> | null => {
  const m = pathname.match(re);
  return m ? { id: m[1] as string } : null;
};

async function handleAclPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const from_agent = body.from_agent;
  const to_agent = body.to_agent;

  if (typeof from_agent !== 'string' || !from_agent || typeof to_agent !== 'string' || !to_agent) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'from_agent and to_agent are required' }));
    return;
  }

  const granted_by = typeof body.granted_by === 'string' ? body.granted_by : 'system';
  // F0a: local-endpoint existence is enforced by aclGrant — ONE rule at the
  // chokepoint, not a copy per door.
  //
  // This route used to pre-check both endpoints with getAgentById and 404 on
  // null. Those gates are DELETED rather than given their own ':' exemption:
  // with them in place the HTTP door 404'd a remote id while the MCP door
  // accepted it, which is two doors with two rules on the pair #82 pinned for
  // exactly that. A second exemption would have kept the duplication and made
  // the rules agree only for as long as someone maintained both.
  //
  // The refusal a caller sees is unchanged for a bare unknown id: aclGrant
  // throws AGENT_NOT_FOUND and it maps to the same 404 below.
  let row;
  try {
    row = aclGrant(db, from_agent, to_agent, granted_by);
  } catch (err) {
    if ((err as { code?: string }).code === 'AGENT_NOT_FOUND') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found' }));
      return;
    }
    // F1b (§5.4): the peering rule lives in aclGrant, so this door only MAPS
    // its refusal. 409, not 404: the endpoint may well exist on the far mesh —
    // what is missing is the peering, which is a conflict with our state rather
    // than a claim about theirs.
    if ((err as { code?: string }).code === 'NO_PEERING') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no peering' }));
      return;
    }
    throw err; // anything else is a real fault — let the dispatcher guard log it
  }

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(row));
}

async function handleAclDelete(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const from_agent = body.from_agent;
  const to_agent = body.to_agent;

  if (typeof from_agent !== 'string' || !from_agent || typeof to_agent !== 'string' || !to_agent) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'from_agent and to_agent are required' }));
    return;
  }

  // F0a: the rule for revoke is EDGE existence, not endpoint existence.
  //
  // These two gates used to 404 on an endpoint that was not a local agent —
  // which since aclGrant accepts remote ids would leave THIS door unable to
  // revoke what the MCP door could: mesh_acl_deny has no such gate, so the edge
  // was always withdrawable there. Each door was internally consistent; the
  // defect was the gap between them, and a revoke one door cannot perform is
  // worse than one that reports nothing to do.
  //
  // 404 now means what it should have meant here all along — no such edge.
  const removed = aclRevoke(db, from_agent, to_agent);
  if (removed === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'edge not found' }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function handleAclGet(ctx: AdminCtx): void {
  const { res, db, url } = ctx;
  const agent = url.searchParams.get('agent');
  const grantedBy = url.searchParams.get('granted_by');            // exact
  const grantedByPrefix = url.searchParams.get('granted_by_prefix'); // prefix

  // At most one granted_by mode (exact vs prefix are mutually exclusive).
  if (grantedBy !== null && grantedByPrefix !== null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'provide at most one of granted_by, granted_by_prefix' }));
    return;
  }

  // At least one selector is required (matches the original agent-required rule).
  if (!agent && grantedBy === null && grantedByPrefix === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'one of agent, granted_by, or granted_by_prefix is required' }));
    return;
  }

  // Agent-scoped (back-compat): {inbound, outbound}, optionally narrowed by
  // granted_by/prefix (JS filter — an agent's ACL set is small).
  if (agent) {
    // F1b: the local-existence gate that used to sit here is GONE — one rule
    // at the chokepoint, and F0a's sweep missed this third site. Listing for an
    // unknown or REMOTE id now returns an empty list rather than 404. No oracle
    // is opened: this route is admin-authenticated, so the caller may already
    // enumerate agents.
    let inbound = listInboundAcl(db, agent);
    let outbound = listOutboundAcl(db, agent);
    if (grantedBy !== null) {
      inbound = inbound.filter((r) => r.granted_by === grantedBy);
      outbound = outbound.filter((r) => r.granted_by === grantedBy);
    } else if (grantedByPrefix !== null) {
      inbound = inbound.filter((r) => r.granted_by.startsWith(grantedByPrefix));
      outbound = outbound.filter((r) => r.granted_by.startsWith(grantedByPrefix));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ inbound, outbound }));
    return;
  }

  // Global provenance query (no agent): flat {matches} list — the reconciler
  // path ("every edge I stamped under <namespace>").
  const matches = grantedBy !== null
    ? listAclByGrantedBy(db, grantedBy)
    : listAclByGrantedByPrefix(db, grantedByPrefix as string);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ matches }));
}

async function handleObserverPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db, agentIndex, observerIndex } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); }
  catch { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'invalid JSON'})); return; }

  const agent_id = body.agent_id;
  if (typeof agent_id !== 'string' || !agent_id) {
    res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'agent_id is required'})); return;
  }
  if (getAgentById(db, agent_id) === null) {
    res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'agent not found'})); return;
  }
  const granted_by = typeof body.granted_by === 'string' ? body.granted_by : 'system';
  // F3: the wider scope must be asked for EXPLICITLY and with a boolean true.
  // Not truthiness — `"false"`, `0`, `"no"` and a stray `{}` all mean "did not
  // ask", and a grant that widens on a typo is the failure this scope exists to
  // stop. An absent field is a narrow grant, which is also what a pre-F3 client
  // sends, so old callers keep getting exactly what they got before.
  if (body.cross_border !== undefined && typeof body.cross_border !== 'boolean') {
    res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'cross_border must be a boolean'})); return;
  }
  const cross_border = body.cross_border === true;
  const row = grantObserver(db, agent_id, granted_by, cross_border);
  // Live-activate for a currently-connected socket (no reconnect needed).
  try { const ws = agentIndex.get(agent_id); if (ws !== undefined) observerIndex.set(agent_id, ws); } catch (_) { /* never 500 on live-index update */ }
  res.writeHead(201, {'Content-Type':'application/json'}); res.end(JSON.stringify(row));
}

function handleObserverDelete(ctx: AdminCtx): void {
  const { res, db, observerIndex, params } = ctx;
  const id = params.id;
  const removed = revokeObserver(db, id);
  if (!removed) {
    res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not an observer'})); return;
  }
  try { observerIndex.delete(id); } catch (_) { /* never 500 on live-index update */ }
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
}

function handleObserverGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(listObservers(db)));
}

async function handleTopicPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const name = body.name;
  const created_by = body.created_by;

  if (typeof name !== 'string' || !name) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'name is required' }));
    return;
  }

  if (typeof created_by !== 'string' || !created_by) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'created_by is required' }));
    return;
  }

  if (getAgentById(db, created_by) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'created_by agent not found' }));
    return;
  }

  const description = typeof body.description === 'string' ? body.description : '';
  const metadata = body.metadata !== undefined ? JSON.stringify(body.metadata) : '{}';
  const topic = getOrCreateTopic(db, name, created_by, description, metadata);

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(topic));
}

function handleTopicGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  const topics = listTopics(db);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(topics));
}

async function handleAgentPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const id = body.id;
  const hostname = body.hostname;

  if (typeof id !== 'string' || !id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'id is required' }));
    return;
  }

  if (typeof hostname !== 'string' || !hostname) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'hostname is required' }));
    return;
  }

  if (getAgentById(db, id) !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent already exists' }));
    return;
  }

  // Optional namespace (#41): a string sets it, absent leaves it null. The bus
  // attaches no semantics to the value.
  let namespace: string | null = null;
  if (Object.prototype.hasOwnProperty.call(body, 'namespace')) {
    if (body.namespace !== null && typeof body.namespace !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'namespace must be a string or null' }));
      return;
    }
    namespace = body.namespace as string | null;
  }

  // F0b (§6) — id rules that only bind NEW agents. Existing ids are untouched:
  // a validation change must not make a live agent unable to re-register, so
  // legacy ':' ids are reported at boot instead (see server.ts) rather than
  // being retroactively rejected here.
  if (id.includes(':')) {
    // ':' separates mesh from agent in a remote id. A local id containing one
    // would be indistinguishable from a remote address.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "agent id must not contain ':'" }));
    return;
  }
  if (id === RESERVED_ALIAS) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `agent id '${RESERVED_ALIAS}' is reserved` }));
    return;
  }
  // Same collision as the mint-side check, from the other direction: whichever
  // is created second is the one refused.
  //
  // TABLES READ, and why their union covers the state space: `peers` (a peer
  // that has registered) and `peer_keys` (one that has been minted but not yet
  // registered). A peer alias can only exist in those two states, so together
  // they are total. The mint-side gate reads `agents` and `peer_keys`, which is
  // the same argument from the other side.
  //
  // The gap this closes was NOT an unpinned gate — both gates were pinned. It
  // was two pinned gates whose union missed a state, which mutation cannot
  // find: every mutant of either gate died correctly while the hole stayed
  // open. It was found by asking what tables each gate reads.
  //
  // BOTH tables are consulted, and the peer_keys half is the one that matters:
  // a MINTED-but-not-yet-registered key lives only in peer_keys, so a gate that
  // looked at `peers` alone let this sequence through —
  //   mint key "x" -> register agent "x" (gate passes, peers is empty)
  //     -> peer registers with its key -> upsertPeer("x") succeeds
  // producing ONE id with TWO identities and no error at any step. Minting IS a
  // creation, so under the rule above the agent is the one refused.
  if (getPeerByAlias(db, id) !== null || getLivePeerKeyForAlias(db, id, Date.now()) !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent id collides with an existing peer alias' }));
    return;
  }

  const rawToken = generateToken();
  const token_hash = hashToken(rawToken);
  const agent = registerAgent(db, { id, token_hash, hostname, namespace });

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...formatAgent(agent), token: rawToken }));
}

function handleAgentGet(ctx: AdminCtx): void {
  const { res, db, url } = ctx;
  const onlineOnly = url.searchParams.get('online') === 'true';
  const agents = listAgents(db, onlineOnly);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(agents.map(formatAgent)));
}

function handleAgentById(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id;
  const agent = getAgentById(db, id);
  if (agent === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(formatAgent(agent)));
}

function handleAgentDelete(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id;
  const agent = getAgentById(db, id);
  if (agent === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }
  try {
    deleteAgent(db, id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'delete failed', detail: msg }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handleAgentPatch(ctx: AdminCtx): Promise<void> {
  const { req, res, db, params } = ctx;
  const id = params.id as string; // idMatch always populates :id
  if (getAgentById(db, id) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }

  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  // Genuine PARTIAL update: only fields PRESENT in the body are touched. An
  // omitted field is left exactly as-is (never nulled). metadata is REPLACE
  // (not merge) — consumers do read-modify-write.
  const fields: { metadata?: string; namespace?: string | null } = {};

  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    const metadata = body.metadata;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'metadata must be a JSON object' }));
      return;
    }
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized, 'utf8') > 4096) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'metadata exceeds 4096 bytes' }));
      return;
    }
    fields.metadata = serialized;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'namespace')) {
    if (body.namespace !== null && typeof body.namespace !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'namespace must be a string or null' }));
      return;
    }
    fields.namespace = body.namespace as string | null;
  }

  const updated = updateAgent(db, id, fields);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(formatAgent(updated as Agent)));
}

function handleMessagesGet(ctx: AdminCtx): void {
  const { res, db, url, auth } = ctx;
  const agentParam = url.searchParams.get('agent') || undefined;
  const topicParam = url.searchParams.get('topic') || undefined;
  const sinceRaw = url.searchParams.get('since');
  const limitRaw = url.searchParams.get('limit');
  // Optional kind filter (#38-family): `kinds=direct,request,response,file` lets
  // a DM/scrollback scan skip high-volume 'topic' beat rows. Whitelisted so an
  // arbitrary value can't reach the SQL; empty after filtering = no constraint.
  const KNOWN_KINDS = ['direct', 'topic', 'request', 'response', 'file', 'reminder'];
  const kindsRaw = url.searchParams.get('kinds');
  const kinds = kindsRaw
    ? kindsRaw.split(',').map(k => k.trim()).filter(k => KNOWN_KINDS.includes(k))
    : undefined;

  const since = sinceRaw !== null ? parseInt(sinceRaw, 10) : undefined;
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : undefined;

  // Backward pagination (#36): opaque `before` cursor = "<sent_at>:<id>",
  // derived by the client from the oldest row of the previous page. Rows
  // strictly older than the cursor are returned (stable sent_at,id tie-break),
  // so "load older" tiles without duplicates or gaps even across equal sent_at.
  let before: { sentAt: number; id: string } | undefined;
  const beforeRaw = url.searchParams.get('before');
  if (beforeRaw !== null) {
    const sep = beforeRaw.indexOf(':');
    const sentAt = sep > 0 ? parseInt(beforeRaw.slice(0, sep), 10) : NaN;
    const id = sep > 0 ? beforeRaw.slice(sep + 1) : '';
    if (Number.isNaN(sentAt) || id === '') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid before cursor (expected "<sent_at>:<id>")' }));
      return;
    }
    before = { sentAt, id };
  }

  // Node-scoped read (#35): a non-admin agent only ever sees traffic it is a
  // party to. The (from_agent = X OR to_agent = X) scope covers direct, topic
  // (persisted as per-subscriber copies with to_agent = subscriber), and
  // request/response rows. Requesting another agent's scope is a hard 403;
  // admin is unconstrained (behaves exactly as before).
  // 'unauthenticated' must never reach here — this route is not handler-mode,
  // so the dispatcher already refused. If it ever does, that is a routing bug,
  // and the safe reading is NOT "unconstrained like admin": refuse rather than
  // fall through to the admin path below.
  if (auth.mode === 'unauthenticated') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  let effectiveAgent = agentParam;
  if (auth.mode === 'agent') {
    if (agentParam !== undefined && agentParam !== auth.agentId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: cannot query another agent' }));
      return;
    }
    effectiveAgent = auth.agentId;
  }

  const messages = queryMessages(db, {
    agent: effectiveAgent,
    topic: topicParam,
    since: Number.isNaN(since) ? undefined : since,
    limit: Number.isNaN(limit) ? undefined : limit,
    before,
    kinds,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(messages));
}

/**
 * RFC 6266/5987 Content-Disposition for an untrusted filename.
 *
 * WHY THIS EXISTS (2026-08-01 incident): filenames are agent-supplied and were
 * interpolated raw into a header. Node/Bun validate header values as latin1 —
 * one em-dash (U+2014) in a stored filename made writeHead throw
 * ERR_INVALID_CHAR, which killed the WHOLE server process. The container
 * stayed "Up" (sleep-style PID 1), so only mesh presence saw it — and the
 * recipient's inbox auto-refetch turned it into a crash LOOP on every
 * restart. One filename, whole-mesh DoS, invisible to container health.
 *
 * Shape: an ASCII-only `filename="…"` fallback (non-printables and the two
 * quote-breakers replaced), plus `filename*=UTF-8''…` carrying the real name
 * percent-encoded per RFC 5987 (encodeURIComponent, then the four chars it
 * leaves bare that are NOT attr-chars). Every modern client prefers the
 * starred form, so unicode names round-trip; the fallback cannot contain a
 * byte writeHead rejects.
 */
export function contentDispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Content-Type is the SAME injection vector one line up: it is stored from
 * whatever the sender's SDK passed as contentType, and a non-latin1 byte in it
 * kills writeHead identically. A well-formed type/subtype (with optional
 * parameters, printable-ASCII only) passes through; anything else serves as
 * octet-stream rather than 500ing a file whose bytes are fine.
 */
const SAFE_CONTENT_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[\x20-\x7e]*)?$/;

export function safeContentType(ct: string | null | undefined): string {
  if (typeof ct === 'string' && ct.length <= 256 && SAFE_CONTENT_TYPE.test(ct)) return ct;
  return 'application/octet-stream';
}

async function handleFileById(ctx: AdminCtx): Promise<void> {
  const { res, db, params, auth } = ctx;
  const id = params.id;
  const file = getFile(db, id);

  // Node-scoped read (#57): an AGENT may fetch a file only if it is that file's
  // sender or recipient; admin has full access. Deny-by-default returns the
  // SAME 404 as a missing file — an agent cannot distinguish "no such file"
  // from "exists but not yours", so it can't enumerate/probe file_ids across
  // nodes (no existence oracle). from_agent/to_agent are already stored.
  const authorized = file !== null && fileAccessAuthorized(auth, file);
  if (!authorized) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file not found' }));
    return;
  }

  const bunFile = Bun.file(file.file_path);
  if (!await bunFile.exists()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file not found' }));
    return;
  }

  const content = Buffer.from(await bunFile.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': safeContentType(file.content_type),
    'Content-Disposition': contentDispositionFor(file.filename),
    'Content-Length': String(content.byteLength),
  });
  res.end(content);
}

async function handleFilePost(ctx: AdminCtx): Promise<void> {
  const { req, res, db, agentIndex, maxFileBytes, filesDir } = ctx;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const rawBody = Buffer.concat(chunks);

    const bunReq = new Request(`http://localhost${req.url}`, {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: rawBody,
    });

    let formData: FormData;
    try {
      formData = await bunReq.formData();
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid form data' }));
      return;
    }

    const fileBlob = formData.get('file');
    const from_agent = formData.get('from_agent');
    const to_agent = formData.get('to_agent');
    const caption = formData.get('caption');
    const reply_to_msg_id = formData.get('reply_to_msg_id');
    const ttl_ms_str = formData.get('ttl_ms');

    if (!fileBlob || typeof fileBlob === 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file is required and must be a file upload' }));
      return;
    }

    if (typeof from_agent !== 'string' || !from_agent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'from_agent is required' }));
      return;
    }

    if (typeof to_agent !== 'string' || !to_agent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'to_agent is required' }));
      return;
    }

  // DELIBERATELY LOCAL-ONLY, and NOT part of the acl chokepoint migration
  // (F0a). File delivery has no remote endpoint in F0 — cross-mesh transfer is
  // later work — so these two gates are load-bearing here rather than a
  // leftover copy of the idiom aclGrant now owns. The next "one rule at the
  // chokepoint" sweep must skip them.
    if (getAgentById(db, from_agent) === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'from_agent not found' }));
      return;
    }

    if (getAgentById(db, to_agent) === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'to_agent not found' }));
      return;
    }

    if (!aclCheck(db, from_agent, to_agent)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ACL denied' }));
      return;
    }

    const fileBlobObj = fileBlob as File;
    const size_bytes = fileBlobObj.size;
    if (size_bytes > maxFileBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `file exceeds ${maxFileBytes} byte limit` }));
      return;
    }

    if (caption !== null && typeof caption === 'string' && Buffer.byteLength(caption, 'utf8') > 4096) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'caption exceeds 4096 byte limit' }));
      return;
    }

    const file_id = crypto.randomUUID();
    const filePath = `${filesDir}/${file_id}`;
    await Bun.write(filePath, fileBlobObj);

    const ttl_ms_val = ttl_ms_str ? parseInt(ttl_ms_str as string, 10) : 300_000;
    const ttl = isNaN(ttl_ms_val) ? 300_000 : ttl_ms_val;
    const expires_at = ttl === 0 ? null : Date.now() + ttl;

    const filename = fileBlobObj.name || 'upload';
    const content_type = fileBlobObj.type || 'application/octet-stream';
    const sent_at = Date.now();

    insertFile(db, {
      id: file_id,
      from_agent,
      to_agent,
      filename,
      content_type,
      size_bytes,
      file_path: filePath,
      sent_at,
      expires_at,
      caption: (caption as string) ?? null,
      reply_to_msg_id: (reply_to_msg_id as string) ?? null,
    });

    const recipientWs = agentIndex.get(to_agent);
    if (recipientWs !== undefined) {
      const deliverFrame = JSON.stringify({
        type: 'file_deliver',
        file_id,
        from: from_agent,
        to: to_agent,
        filename,
        content_type,
        size_bytes,
        sent_at,
        fetch_url: `/files/${file_id}`,
        caption: (caption as string) ?? null,
        reply_to_msg_id: (reply_to_msg_id as string) ?? null,
      });
      recipientWs.send(deliverFrame);
      markFileDelivered(db, file_id);
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      file_id,
      from_agent,
      to_agent,
      filename,
      content_type,
      size_bytes,
      caption: (caption as string) ?? null,
      sent_at,
    }));
    return;
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid form data' }));
    return;
  }
}

async function handleReminderPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const agent_id = body.agent_id;
  const payload = body.payload;

  if (typeof agent_id !== 'string' || !agent_id || getAgentById(db, agent_id) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }

  if (typeof payload !== 'string' || payload.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payload is required and must be a non-empty string' }));
    return;
  }
  if (Buffer.byteLength(payload, 'utf8') > 4096) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'payload exceeds 4096 bytes' }));
    return;
  }

  const hasSchedule = body.schedule !== undefined;
  const hasDueAt = body.due_at !== undefined;
  const hasDuration = body.duration !== undefined;
  const timingCount = (hasSchedule ? 1 : 0) + (hasDueAt ? 1 : 0) + (hasDuration ? 1 : 0);

  if (timingCount !== 1) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'exactly one of schedule, due_at, or duration is required' }));
    return;
  }

  // Optional per-reminder IANA timezone (mirrors WS remind).
  const tzRaw = body.tz;
  if (tzRaw !== undefined && (typeof tzRaw !== 'string' || !tzValidate(tzRaw))) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid IANA timezone' }));
    return;
  }
  const tz = (typeof tzRaw === 'string') ? tzRaw : null;

  let due_at: number;
  let schedule: string | null;

  if (hasSchedule) {
    const sched = body.schedule;
    if (typeof sched !== 'string' || !cronValidate(sched)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid cron expression' }));
      return;
    }
    const next = tz !== null ? cronNextTz(sched, Date.now(), tz) : cronNext(sched, Date.now());
    if (next === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cron has no future occurrence within 366 days' }));
      return;
    }
    due_at = next;
    schedule = sched;
  } else if (hasDueAt) {
    const dueAtVal = body.due_at;
    if (tz !== null && typeof dueAtVal === 'string' && isBareIso(dueAtVal)) {
      // Bare offset-less ISO + tz → interpret as wall-clock in tz.
      due_at = bareIsoToUtc(dueAtVal, tz);
      schedule = null;
    } else if (typeof dueAtVal === 'number' && Number.isFinite(dueAtVal) && dueAtVal > Date.now()) {
      due_at = dueAtVal;
      schedule = null;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'due_at must be a future unix ms timestamp' }));
      return;
    }
  } else {
    const durVal = body.duration;
    const parsed = typeof durVal === 'string' ? parseDuration(durVal) : null;
    if (parsed === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'duration is unparseable or zero' }));
      return;
    }
    due_at = Date.now() + parsed;
    schedule = null;
  }

  const rem = insertReminder(db, {
    id: crypto.randomUUID(),
    agent_id,
    due_at,
    schedule,
    payload,
    created_at: Date.now(),
    tz,
  });

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rem));
}

function handleReminderGet(ctx: AdminCtx): void {
  const { res, db, url } = ctx;
  const agent_id = url.searchParams.get('agent_id');
  if (agent_id) {
    // Optional filter: pending reminders for a single agent (back-compat).
    if (getAgentById(db, agent_id) === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found' }));
      return;
    }
    const reminders = listAgentReminders(db, agent_id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reminders));
    return;
  }
  // No agent_id: all pending reminders across the fleet (dashboard view).
  const reminders = listAllReminders(db);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reminders));
}

async function handleReminderPatch(ctx: AdminCtx): Promise<void> {
  const { req, res, db, params } = ctx;
  const id = params.id;
  const existing = getReminder(db, id);
  if (existing === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'reminder not found' }));
    return;
  }

  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  // payload — optional, unchanged if absent
  let payload = existing.payload;
  if (body.payload !== undefined) {
    if (typeof body.payload !== 'string' || body.payload.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload must be a non-empty string' }));
      return;
    }
    if (Buffer.byteLength(body.payload, 'utf8') > 4096) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload exceeds 4096 bytes' }));
      return;
    }
    payload = body.payload;
  }

  // tz — optional. Present key resolves it (string→validate, null→clear to UTC); absent→unchanged.
  let tz = existing.tz;
  let tzChanged = false;
  if (Object.prototype.hasOwnProperty.call(body, 'tz')) {
    const tzRaw = body.tz;
    if (tzRaw === null) {
      tz = null;
      tzChanged = true;
    } else if (typeof tzRaw === 'string' && tzValidate(tzRaw)) {
      tz = tzRaw;
      tzChanged = true;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid IANA timezone' }));
      return;
    }
  }

  // when-field — at most one of schedule | due_at | duration
  const hasSchedule = body.schedule !== undefined;
  const hasDueAt = body.due_at !== undefined;
  const hasDuration = body.duration !== undefined;
  const timingCount = (hasSchedule ? 1 : 0) + (hasDueAt ? 1 : 0) + (hasDuration ? 1 : 0);
  if (timingCount > 1) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'at most one of schedule, due_at, or duration may be provided' }));
    return;
  }

  let schedule = existing.schedule;
  let due_at = existing.due_at;

  if (hasSchedule) {
    const sched = body.schedule;
    if (typeof sched !== 'string' || !cronValidate(sched)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'schedule must be a valid cron expression (to make a one-shot, set due_at or duration)' }));
      return;
    }
    const next = tz !== null ? cronNextTz(sched, Date.now(), tz) : cronNext(sched, Date.now());
    if (next === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cron has no future occurrence within 366 days' }));
      return;
    }
    schedule = sched;
    due_at = next;
  } else if (hasDueAt) {
    const dueAtVal = body.due_at;
    if (tz !== null && typeof dueAtVal === 'string' && isBareIso(dueAtVal)) {
      due_at = bareIsoToUtc(dueAtVal, tz);
      schedule = null;
    } else if (typeof dueAtVal === 'number' && Number.isFinite(dueAtVal) && dueAtVal > Date.now()) {
      due_at = dueAtVal;
      schedule = null;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'due_at must be a future unix ms timestamp' }));
      return;
    }
  } else if (hasDuration) {
    const durVal = body.duration;
    const parsed = typeof durVal === 'string' ? parseDuration(durVal) : null;
    if (parsed === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'duration is unparseable or zero' }));
      return;
    }
    due_at = Date.now() + parsed;
    schedule = null;
  } else if (tzChanged && existing.schedule !== null) {
    // No when-field, but tz changed on a recurring reminder → recompute next due in the new tz.
    const next = tz !== null ? cronNextTz(existing.schedule, Date.now(), tz) : cronNext(existing.schedule, Date.now());
    if (next === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cron has no future occurrence within 366 days' }));
      return;
    }
    due_at = next;
  }

  const updated = updateReminder(db, id, { payload, schedule, due_at, tz });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(updated));
}

function handleReminderDelete(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id;
  const rem = getReminder(db, id);
  if (rem === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'reminder not found' }));
    return;
  }
  const cancelled = dbCancelReminder(db, id);
  if (!cancelled) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'reminder not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// Ordered route table — matched top-to-bottom, first match wins. Order mirrors
// the original inline if-chain exactly (exact paths before their `/:id`
// siblings). A path that matches no (method, matcher) pair falls through to the
// 404 at the end of dispatch — there is intentionally no 405.
/** Exported for tests ONLY: the dispatcher-guard test injects a throwing
    route to prove a handler exception cannot kill the process. */
/**
 * Who may read a file's bytes (#57): admin unconditionally, an agent only if it
 * is the file's sender or recipient.
 *
 * Exhaustive over AuthResult BY CONSTRUCTION — a switch with a `never` arm, so
 * adding a fourth mode is a compile error here rather than a silent grant.
 * Written as a POSITIVE test per mode, never "not X ⇒ allow".
 */
export function fileAccessAuthorized(
  auth: AuthResult,
  file: { from_agent: string; to_agent: string }
): boolean {
  switch (auth.mode) {
    case 'admin':
      return true;
    case 'agent':
      return file.from_agent === auth.agentId || file.to_agent === auth.agentId;
    case 'unauthenticated':
      return false; // the dispatcher checked no credential. Never a grant.
    default: {
      const exhaustive: never = auth;
      return exhaustive;
    }
  }
}

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
    return { mode: 'unauthenticated' };
  }
  if (mode === 'agentOrAdmin') {
    return resolveAuth(req, res, db, adminToken);
  }
  // 'admin' and the no-route case: unmatched paths still require the admin
  // token before the 404, so an unauthenticated caller cannot probe which
  // routes exist.
  if (!requireAdmin(req, res, adminToken)) return null;
  return { mode: 'admin' };
}

// ─── Peer keys and peer registration (F0b — §3, §4, §6) ─────────────────────

/** Public shape of a peer key. NEVER includes key_hash: the mint response is
    the only time the secret exists, and a listing that leaked the hash would
    make every stored key offline-crackable from an admin-read alone. */
function publicPeerKeyFields(db: Database, key: PeerKey) {
  const peer = getPeerByAlias(db, key.alias);
  return {
    id: key.id,
    alias: key.alias,
    kinds: JSON.parse(key.kinds) as string[],
    rate_per_min: key.rate_per_min,
    expires_at: key.expires_at,
    revoked_at: key.revoked_at,
    rotates: key.rotates,
    note: key.note,
    created_at: key.created_at,
    // Per-alias live state, so an operator can see whether the key was used
    // without joining two listings by hand.
    registered: peer !== null,
    peer_disabled: peer === null ? null : peer.disabled === 1,
  };
}

async function handlePeerKeyPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' })); return;
  }

  const alias = body.alias;
  if (typeof alias !== 'string' || !PEER_ALIAS_RE.test(alias)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias must match ^[a-z0-9][a-z0-9-]{0,62}$' })); return;
  }
  if (alias === RESERVED_ALIAS) {
    // 'mesh' names THIS mesh in every remote id. A peer holding it would make
    // its traffic indistinguishable from local traffic — refused at mint, the
    // only point where refusing is cheap.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `alias '${RESERVED_ALIAS}' is reserved` })); return;
  }
  if (getAgentById(db, alias) !== null) {
    // A peer alias and a local agent id share one id space at the point of
    // address resolution, so a collision makes routing ambiguous.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias collides with an existing local agent id' })); return;
  }

  const now = Date.now();
  if (getLivePeerKeyForAlias(db, alias, now) !== null) {
    // One live key per alias: two would mean two secrets can register the same
    // peer, so revoking one would leave a door open that the operator believes
    // they closed.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'a live key already exists for this alias' })); return;
  }

  let kinds: string[] = ['direct'];
  if (body.kinds !== undefined) {
    if (!Array.isArray(body.kinds) || !body.kinds.every(k => typeof k === 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'kinds must be an array of strings' })); return;
    }
    kinds = body.kinds as string[];
  }

  let rate_per_min = 600;
  if (body.rate_per_min !== undefined) {
    if (typeof body.rate_per_min !== 'number' || !Number.isInteger(body.rate_per_min) || body.rate_per_min <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_per_min must be a positive integer' })); return;
    }
    rate_per_min = body.rate_per_min;
  }

  let expires_at: number | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    if (typeof body.expires_at !== 'number' || !Number.isInteger(body.expires_at)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'expires_at must be an integer ms timestamp' })); return;
    }
    expires_at = body.expires_at;
  }

  // #113: a ROTATION declares the key it replaces. Absent means rebind, which
  // is the safe default — the alias's inbound edges are dropped at registration.
  // Validated as a string only; whether it MATCHES the peer row's current key
  // is decided at registration, where the row is the authority.
  let rotates: string | null = null;
  if (body.rotates !== undefined && body.rotates !== null) {
    if (typeof body.rotates !== 'string' || body.rotates.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rotates must be a key id' })); return;
    }
    rotates = body.rotates;
  }

  const secret = generateToken();
  const key = insertPeerKey(db, {
    id: crypto.randomUUID(),
    key_hash: hashToken(secret),
    alias,
    kinds: JSON.stringify(kinds),
    rate_per_min,
    expires_at,
    note: typeof body.note === 'string' ? body.note : null,
    created_at: now,
    rotates,
  });

  console.log(JSON.stringify({
    evt: 'peer_key.minted', key_id: key.id, alias, kinds, rate_per_min, expires_at, at: now,
  }));

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...publicPeerKeyFields(db, key),
    key: secret, // shown ONCE, never stored in the clear, never listed
  }));
}

function handlePeerKeyGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys: listPeerKeys(db).map(k => publicPeerKeyFields(db, k)) }));
}

/**
 * Close a peer's live socket, if it has one. F1a: the ACTION half of
 * revocation — the cleanup sweep is the STATE half and runs regardless, so a
 * missed close here costs at most PEER_SWEEP_INTERVAL_MS rather than leaving a
 * revoked peer connected indefinitely. Best-effort by design; a socket that
 * cannot be closed is exactly what the sweep exists for.
 */
function closePeerSocket(ctx: AdminCtx, alias: string, code: string, message: string): void {
  const sock = ctx.peerIndex.get(alias);
  if (sock === undefined) return;
  try { sock.send(JSON.stringify({ type: 'error', code, message })); } catch { /* ignore */ }
  try { sock.close(1008, message); } catch { /* ignore */ }
}

function handlePeerKeyDelete(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id as string;
  if (!revokePeerKey(db, id)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such live peer key' })); return;
  }
  // F1a: close the live socket NOW. revokePeerKey already set disabled=1 in its
  // transaction, so the sweep would close it within 15 s regardless — this is
  // the fast path, not the guarantee.
  const revokedKey = getPeerKeyById(db, id);
  if (revokedKey !== null) closePeerSocket(ctx, revokedKey.alias, 'AUTH_FAILED', 'invalid token');

  console.log(JSON.stringify({ evt: 'peer_key.revoked', key_id: id, at: Date.now() }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ revoked: true, id }));
}

/** UNIFORM PER C9 — one 403 body for every cause, the reason to the LOG only.
 *  This door is reached by a caller outside the trust boundary presenting a
 *  secret, so distinguishing "unknown key" from "revoked" from "expired" would
 *  make it an oracle for which keys exist. The operator still gets the reason,
 *  because a structured log is not the prober-reachable surface.
 *
 *  Every registration refusal returns THIS — one body, one status, no detail.
 *  A peer presenting a wrong, revoked, expired, or nonexistent key learns only
 *  that it was refused. */
/** Why a presented key was not live, FOR THE LOG LINE ONLY. Reads the columns
 *  directly and deliberately: it feeds a diagnostic string and never a branch,
 *  so it cannot become a second authority on liveness. The 403 body is uniform
 *  regardless (§6) — this changes what the OPERATOR sees, never the peer. */
function describeDeadKey(db: Database, secret: string): string {
  const row = db.prepare('SELECT revoked_at, expires_at FROM peer_keys WHERE key_hash = ? LIMIT 2')
    .all(hashToken(secret)) as { revoked_at: number | null; expires_at: number | null }[];
  if (row.length !== 1) return 'unknown_key';
  const k = row[0]!;
  if (k.revoked_at !== null) return 'revoked_key';
  if (k.expires_at !== null && k.expires_at <= Date.now()) return 'expired_key';
  return 'unknown_key';
}

function refusePeerRegistration(res: http.ServerResponse, reason: string, alias: string | null): void {
  console.log(JSON.stringify({ evt: 'peer.register_refused', reason, alias, at: Date.now() }));
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'registration refused' }));
}

async function handlePeerRegister(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  // auth:'handler' — the dispatcher checked NOTHING. This handler is the only
  // authentication on this route, and ctx.auth is 'unauthenticated' by
  // construction so nothing it was handed can act as a grant.
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    refusePeerRegistration(res, 'invalid_json', null); return;
  }

  const presented = body.key;
  if (typeof presented !== 'string' || presented.length === 0) {
    refusePeerRegistration(res, 'missing_key', null); return;
  }

  const key = getPeerKeyBySecret(db, presented);
  if (key === null) {
    // DIAGNOSTIC ONLY — never a branch. The refusal has already been decided
    // above; this reads the columns solely to say WHY in the log, so an
    // operator can tell a revoked key from an expired one from a wrong one.
    // It must not become a condition: a second reader of these columns is how
    // the third authority appeared in the first place.
    refusePeerRegistration(res, describeDeadKey(db, presented), null);
    return;
  }
  // No liveness branch here. getPeerKeyBySecret returns null for a key that is
  // not live, by the SAME definition the mint gate and the boot report use — so
  // this handler has no opinion of its own to drift from theirs. It used to
  // read revoked_at and expires_at itself and agree by coincidence, which is
  // the property #103 exists to remove, on the highest-stakes consumer: this is
  // the call that decides whether a peer obtains a live token.

  // Defence in depth, at the moment the collision becomes REAL rather than
  // latent: the mint-side and agent-side gates should have made this
  // impossible, but a key minted before those gates existed — or any future
  // path that writes peer_keys without them — would otherwise create a second
  // identity for an id that already names a local agent.
  if (getAgentById(db, key.alias) !== null) {
    console.error(JSON.stringify({
      evt: 'peer.register_alias_collision', alias: key.alias, key_id: key.id, at: Date.now(),
    }));
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias collides with an existing local agent id' }));
    return;
  }

  const token = generateToken();
  const peer = upsertPeer(db, {
    alias: key.alias,
    token_hash: hashToken(token),
    minted_by_key: key.id,
    kinds: key.kinds,
    rate_per_min: key.rate_per_min,
    // #113: the lineage the operator declared when minting this key. upsertPeer
    // decides whether it matches the row's current key; this handler carries it
    // rather than interpreting it.
    rotates: key.rotates,
  });

  // §6: re-registration ROTATED the token (upsertPeer), so any socket holding
  // the old one is authenticated with a credential that no longer exists.
  // Closing it makes the rotation effective immediately rather than whenever
  // that socket happens to drop.
  closePeerSocket(ctx, peer.alias, 'AUTH_FAILED', 'invalid token');

  console.log(JSON.stringify({
    evt: 'peer.registered', alias: peer.alias, key_id: key.id, at: Date.now(),
  }));

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    alias: peer.alias,
    token, // shown ONCE
    kinds: JSON.parse(peer.kinds) as string[],
    rate_per_min: peer.rate_per_min,
    // The ONE constant. A literal here advertises a version auth may not
    // accept — registration succeeds, authentication always fails, and it
    // looks like a peer-side fault.
    protocol: PEER_PROTOCOL_VERSION,
  }));
}

// ─── Outbound peerings (F2a — §4, §5.3, §5.6, §6) ───────────────────────────
//
// C9 SCOPE, stated per door: these are ADMIN-authenticated. C9 binds refusals
// reachable from OUTSIDE the trust boundary; an admin holding the token can
// already enumerate agents, peers, keys and peerings, so distinguishable
// refusals here teach nothing and their diagnostic value is real. Uniform
// errors on this door would be the #107 mistake — applying a property of the
// prober-reachable surface to the system.
//
// Every refusal below is therefore SPECIFIC on purpose. That is a decision, not
// an omission.

/**
 * (d)+(g) THE OUTBOUND URL RULE — ONE predicate, both doors.
 *
 * POST and PATCH validated the URL with two COPIES of the same regex and
 * nothing bound them. The likely future edit is a TIGHTENING, and a tightening
 * that lands on one door leaves the other as the bypass — and the other is
 * PATCH, the rotation path, which is exactly where an attacker who can already
 * reach the admin API would look. Two copies of a security predicate is one
 * predicate and one hole waiting to be opened.
 *
 * The rule: `wss://` anywhere; `ws://` ONLY for loopback. Plaintext to a remote
 * host would put `outbound_peers.token` — a live credential (C7) — on the wire
 * in cleartext on every reconnect, and the peer protocol has no other
 * authentication to fall back on.
 *
 * Certificate verification is never disabled: the SDK uses `ws`'s default
 * (rejectUnauthorized: true), and a source-scan test pins that
 * `rejectUnauthorized` appears nowhere in client/ or border.ts — because the
 * usual way this rule dies is one `{ rejectUnauthorized: false }` added to make
 * a staging box work.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function validateOutboundPeerUrl(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'url must be ws:// or wss://' };
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    return { ok: false, error: 'url must be ws:// or wss://' };
  }
  if (parsed.protocol === 'wss:') return { ok: true };
  if (parsed.protocol !== 'ws:') {
    return { ok: false, error: 'url must be ws:// or wss://' };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: 'ws:// is permitted only for loopback; use wss://' };
  }
  return { ok: true };
}

/** Public shape of an outbound peering. NEVER includes `token` (C7): it is a
 *  live credential, and a read API that returned it would put it in every
 *  operator's shell history and every log of this endpoint. */
function publicOutboundFields(row: OutboundPeer) {
  return {
    alias: row.alias,
    url: row.url,
    assigned_alias: row.assigned_alias,
    kinds: JSON.parse(row.kinds) as string[],
    rate_per_min: row.rate_per_min,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    // NO last_responded here. This serialises an OutboundPeer — a PEERING —
    // and its last_alive is the peering's liveness, a different subject from an
    // agent's. #133 exists because one entity's liveness was read as another's;
    // adding a loop-liveness field to a peering row would be the same
    // conflation, committed while fixing it. (It was: an edit matching
    // `last_alive` by name landed here first.)
    last_alive: row.last_alive,
  };
}

async function handleOutboundPeerPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db, forwarders } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' })); return;
  }

  // THE JOIN IN TIME. Between F2a and F2b merging, main would be a complete
  // front half with no back half: a peering could be created, sends to it
  // accepted and ACKED (D8), and the rows would sit forever because nothing
  // drains them — the exact state endOutboundPeering exists to prevent, reached
  // through a scheduling door rather than a code one.
  //
  // So the front half REFUSES until a forwarder factory is registered. F2b
  // registers the real one. A refusal holds regardless of merge order; a
  // process rule holds only while someone remembers it.
  if (forwarders.create === undefined) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no forwarder available' })); return;
  }

  const alias = body.alias;
  if (typeof alias !== 'string' || !PEER_ALIAS_RE.test(alias)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias must match ^[a-z0-9][a-z0-9-]{0,62}$' })); return;
  }
  if (alias === RESERVED_ALIAS) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `alias '${RESERVED_ALIAS}' is reserved` })); return;
  }

  // An outbound alias must not PREFIX a legacy local id. `assertPeeringAllowed`
  // classifies `legacy:node` as LOCAL when such an agent exists — so creating an
  // outbound peering named `legacy` would make that population addressable as
  // remote, and routeDirect's remote branch would capture sends meant for the
  // local agent. The population the classifier calls local must stay local.
  const prefixed = db.prepare('SELECT id FROM agents WHERE id >= ? AND id < ? LIMIT 1')
    .get(`${alias}:`, `${alias};`) as { id: string } | null;
  if (prefixed !== null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `alias would shadow the local agent '${prefixed.id}'` })); return;
  }

  const url = body.url;
  const urlCheck = validateOutboundPeerUrl(url);
  if (!urlCheck.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: urlCheck.error })); return;
  }
  const token = body.token;
  if (typeof token !== 'string' || token.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'token is required' })); return;
  }
  const assigned_alias = body.assigned_alias;
  if (typeof assigned_alias !== 'string' || assigned_alias.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'assigned_alias is required' })); return;
  }
  if (getOutboundPeer(db, alias) !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'an outbound peering already exists for this alias' })); return;
  }

  let kinds: string[] = ['direct'];
  if (body.kinds !== undefined) {
    if (!Array.isArray(body.kinds) || !body.kinds.every(k => typeof k === 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'kinds must be an array of strings' })); return;
    }
    kinds = body.kinds as string[];
  }
  let rate_per_min = 600;
  if (body.rate_per_min !== undefined) {
    if (typeof body.rate_per_min !== 'number' || !Number.isInteger(body.rate_per_min) || body.rate_per_min <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_per_min must be a positive integer' })); return;
    }
    rate_per_min = body.rate_per_min;
  }

  const row = insertOutboundPeer(db, {
    // `url` is narrowed by validateOutboundPeerUrl above, which the compiler
    // cannot see through a returned discriminated union — asserted, not cast
    // past a real unknown.
    alias, url: url as string, token, assigned_alias,
    kinds: JSON.stringify(kinds), rate_per_min, created_at: Date.now(),
  });
  // Event-driven, never polled: the handler that changed the state starts the
  // forwarder. C7 — the row carries the token, so nothing here logs the row.
  forwarders.create(row);
  console.log(JSON.stringify({ evt: 'outbound_peering.created', alias, url, assigned_alias, at: Date.now() }));

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(publicOutboundFields(row)));
}

function handleOutboundPeerGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ peerings: listOutboundPeers(db).map(publicOutboundFields) }));
}

function handleOutboundPeerDelete(ctx: AdminCtx): void {
  const { res, db, params, forwarders } = ctx;
  const alias = params.id as string;
  if (getOutboundPeer(db, alias) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such outbound peering' })); return;
  }
  // Stop first, then end: a forwarder still draining while its rows are being
  // expired would race its own teardown.
  forwarders.stop?.(alias);
  const { expired, edges } = endOutboundPeering(db, alias, 'deleted_by_admin', { delete: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deleted: true, alias, expired_rows: expired, removed_edges: edges }));
}

async function handleOutboundPeerPatch(ctx: AdminCtx): Promise<void> {
  const { req, res, db, params, forwarders } = ctx;
  const alias = params.id as string;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' })); return;
  }
  if (getOutboundPeer(db, alias) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such outbound peering' })); return;
  }

  const patch: { enabled?: boolean; token?: string; url?: string; rate_per_min?: number } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'enabled must be a boolean' })); return;
    }
    patch.enabled = body.enabled;
  }
  if (body.token !== undefined) {
    if (typeof body.token !== 'string' || body.token.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token must be a non-empty string' })); return;
    }
    patch.token = body.token;
  }
  if (body.url !== undefined) {
    // The SAME predicate as POST — see validateOutboundPeerUrl. PATCH is the
    // rotation path and would be the bypass if these ever diverged.
    const check = validateOutboundPeerUrl(body.url);
    if (!check.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: check.error })); return;
    }
    patch.url = body.url as string;
  }
  if (body.rate_per_min !== undefined) {
    if (typeof body.rate_per_min !== 'number' || !Number.isInteger(body.rate_per_min) || body.rate_per_min <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_per_min must be a positive integer' })); return;
    }
    patch.rate_per_min = body.rate_per_min;
  }

  updateOutboundPeer(db, alias, patch);
  const row = getOutboundPeer(db, alias)!;

  // PATCH {enabled:false} is a PAUSE — reversible, and it keeps both the queued
  // rows and the outbound ACL edges. It deliberately does NOT call
  // endOutboundPeering: pausing and ending are different operations, and a
  // paused peering is expected to come back.
  forwarders.stop?.(alias);
  if (row.enabled === 1) forwarders.create!(row);

  console.log(JSON.stringify({
    evt: 'outbound_peering.patched', alias,
    // C7: which FIELDS changed, never their values — token must not reach a log.
    fields: Object.keys(patch), at: Date.now(),
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(publicOutboundFields(row)));
}

export const ROUTES: Route[] = [
  { method: 'POST',   match: exact('/outbound-peers'),               handler: handleOutboundPeerPost },
  { method: 'GET',    match: exact('/outbound-peers'),               handler: handleOutboundPeerGet },
  { method: 'DELETE', match: idMatch(/^\/outbound-peers\/([^/]+)$/), handler: handleOutboundPeerDelete },
  { method: 'PATCH',  match: idMatch(/^\/outbound-peers\/([^/]+)$/), handler: handleOutboundPeerPatch },
  { method: 'POST',   match: exact('/peer-keys'),                    handler: handlePeerKeyPost },
  { method: 'GET',    match: exact('/peer-keys'),                    handler: handlePeerKeyGet },
  { method: 'DELETE', match: idMatch(/^\/peer-keys\/([^/]+)$/),      handler: handlePeerKeyDelete },
  // The ONLY handler-authenticated route: a peer presents a key, which is
  // neither the admin token nor an agent token.
  { method: 'POST',   match: exact('/peers/register'),               handler: handlePeerRegister, auth: 'handler' },
  { method: 'POST',   match: exact('/acl'),                          handler: handleAclPost },
  { method: 'DELETE', match: exact('/acl'),                          handler: handleAclDelete },
  { method: 'GET',    match: exact('/acl'),                          handler: handleAclGet },
  { method: 'POST',   match: exact('/observers'),                    handler: handleObserverPost },
  { method: 'DELETE', match: idMatch(/^\/observers\/([^/]+)$/),      handler: handleObserverDelete },
  { method: 'GET',    match: exact('/observers'),                    handler: handleObserverGet },
  { method: 'POST',   match: exact('/topics'),                       handler: handleTopicPost },
  { method: 'GET',    match: exact('/topics'),                       handler: handleTopicGet },
  { method: 'POST',   match: exact('/agents'),                       handler: handleAgentPost },
  { method: 'GET',    match: exact('/agents'),                       handler: handleAgentGet },
  { method: 'GET',    match: idMatch(/^\/agents\/([^/]+)$/),         handler: handleAgentById },
  { method: 'PATCH',  match: idMatch(/^\/agents\/([^/]+)$/),         handler: handleAgentPatch },
  { method: 'DELETE', match: idMatch(/^\/agents\/([^/]+)$/),         handler: handleAgentDelete },
  { method: 'GET',    match: exact('/messages'),                     handler: handleMessagesGet, auth: 'agentOrAdmin' },
  { method: 'GET',    match: idMatch(/^\/files\/([^/]+)$/),          handler: handleFileById, auth: 'agentOrAdmin' },
  { method: 'POST',   match: exact('/files'),                        handler: handleFilePost },
  { method: 'POST',   match: exact('/reminders'),                    handler: handleReminderPost },
  { method: 'GET',    match: exact('/reminders'),                    handler: handleReminderGet },
  { method: 'PATCH',  match: idMatch(/^\/reminders\/([^/]+)$/),      handler: handleReminderPatch },
  { method: 'DELETE', match: idMatch(/^\/reminders\/([^/]+)$/),      handler: handleReminderDelete },
];

export function startHttpAdmin(
  port: number,
  db: Database,
  adminToken: string,
  maxFileBytes: number = 10_485_760,
  filesDir: string = '/data/files',
  agentIndex: Map<string, WebSocket> = new Map(),
  observerIndex: Map<string, WebSocket> = new Map(),   // NEW — defaulted
  // F1a: alias -> peer socket, so revocation can close the connection NOW
  // rather than waiting for the sweep. Defaulted, so every existing caller and
  // test is unchanged.
  peerIndex: Map<string, WebSocket> = new Map(),
  // F2a: parameter 8, following agentIndex (6) and observerIndex (7) — the
  // same positional convention. Defaulted to an EMPTY registry, so every
  // existing caller and test is unchanged AND gets the inert front half.
  forwarders: ForwarderRegistry = {},
): Promise<HttpAdminHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // /metrics is unauthenticated by design — this listener binds to the admin port
      // which is internal-only (not exposed publicly). Read-only Prometheus exposition.
      if (req.method === 'GET' && new URL(req.url!, 'http://localhost').pathname === '/metrics') {
        try {
          const body = renderMetrics(db);
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(body);
        } catch (_) {
          res.writeHead(500); res.end();
        }
        return;
      }
      const url = new URL(req.url!, 'http://localhost');
      const pathname = url.pathname;
      const method = req.method;

      // Find the matched route first, then apply its auth. This preserves the
      // original ordering: unmatched paths (and admin routes) go through
      // requireAdmin, so an unauthenticated request to an unknown path still
      // gets 401 (not 404). Only 'agentOrAdmin' routes accept an agent token.
      let matched: Route | undefined;
      let params: Record<string, string> = {};
      for (const route of ROUTES) {
        if (route.method !== method) continue;
        const p = route.match(pathname);
        if (p === null) continue;
        matched = route;
        params = p;
        break;
      }

      const auth = resolveRouteAuth(req, res, db, adminToken, matched?.auth);
      if (auth === null) return; // 401 already written

      if (matched) {
        // A handler throw here used to become an unhandled rejection (async
        // createServer callback, no catch) and KILL THE PROCESS — the header
        // incident was one instance; any future handler bug is another. One
        // request fails loudly instead of the whole mesh dying quietly: log,
        // 500 if the head isn't out yet, sever the socket if it is.
        try {
          await matched.handler({ req, res, db, url, params, agentIndex, observerIndex, peerIndex, forwarders, maxFileBytes, filesDir, auth });
        } catch (err) {
          console.error(`[http-admin] handler crashed: ${method} ${pathname}:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          } else {
            res.destroy();
          }
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', reject);

    server.listen(port, () => {
      const handle: HttpAdminHandle = {
        server,
        shutdown(): Promise<void> {
          return new Promise((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          });
        },
      };
      resolve(handle);
    });
  });
}
