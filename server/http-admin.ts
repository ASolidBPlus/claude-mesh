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
import { parseDuration } from './duration.ts';
import { cronValidate, cronNext, tzValidate, cronNextTz, isBareIso, bareIsoToUtc } from './cron.ts';
import { PendingRequest } from './router.ts';
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
type AuthResult = { mode: 'admin' } | { mode: 'agent'; agentId: string };

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
  auth?: 'admin' | 'agentOrAdmin';
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

  const granted_by = typeof body.granted_by === 'string' ? body.granted_by : 'system';
  const row = aclGrant(db, from_agent, to_agent, granted_by);

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

  aclRevoke(db, from_agent, to_agent);

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
    if (getAgentById(db, agent) === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found' }));
      return;
    }
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
  const row = grantObserver(db, agent_id, granted_by);
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
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(messages));
}

async function handleFileById(ctx: AdminCtx): Promise<void> {
  const { res, db, params } = ctx;
  const id = params.id;
  const file = getFile(db, id);
  if (file === null) {
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
    'Content-Type': file.content_type,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
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
const ROUTES: Route[] = [
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
  { method: 'GET',    match: idMatch(/^\/files\/([^/]+)$/),          handler: handleFileById },
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
  pendingRequests: Map<string, PendingRequest> = new Map(),
  observerIndex: Map<string, WebSocket> = new Map(),   // NEW — defaulted
): Promise<HttpAdminHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // /metrics is unauthenticated by design — this listener binds to the admin port
      // which is internal-only (not exposed publicly). Read-only Prometheus exposition.
      if (req.method === 'GET' && new URL(req.url!, 'http://localhost').pathname === '/metrics') {
        try {
          const body = renderMetrics(db, pendingRequests);
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

      let auth: AuthResult;
      if (matched && matched.auth === 'agentOrAdmin') {
        const resolved = resolveAuth(req, res, db, adminToken);
        if (resolved === null) return; // 401 already written
        auth = resolved;
      } else {
        if (!requireAdmin(req, res, adminToken)) return;
        auth = { mode: 'admin' };
      }

      if (matched) {
        await matched.handler({ req, res, db, url, params, agentIndex, observerIndex, maxFileBytes, filesDir, auth });
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
