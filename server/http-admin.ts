import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
import { WebSocket } from 'ws';
import {
  getAgentById,
  aclGrant,
  aclRevoke,
  aclCheck,
  listInboundAcl,
  listOutboundAcl,
  getOrCreateTopic,
  listTopics,
  listAgents,
  Agent,
  getFile,
  insertFile,
  markFileDelivered,
  deleteAgent,
  registerAgent,
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
import { generateToken, hashToken } from './auth.ts';
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

function formatAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    hostname: agent.hostname,
    online: agent.online === 1,
    capabilities: JSON.parse(agent.capabilities) as unknown[],
    metadata: JSON.parse(agent.metadata) as Record<string, unknown>,
    registered_at: agent.registered_at,
    last_seen: agent.last_seen,
  };
}

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
      if (!requireAdmin(req, res, adminToken)) return;

      const url = new URL(req.url!, 'http://localhost');
      const pathname = url.pathname;
      const method = req.method;

      if (pathname === '/acl' && method === 'POST') {
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
        return;
      }

      if (pathname === '/acl' && method === 'DELETE') {
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
        return;
      }

      if (pathname === '/acl' && method === 'GET') {
        const agent = url.searchParams.get('agent');

        if (!agent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent query param required' }));
          return;
        }

        if (getAgentById(db, agent) === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent not found' }));
          return;
        }

        const inbound = listInboundAcl(db, agent);
        const outbound = listOutboundAcl(db, agent);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ inbound, outbound }));
        return;
      }

      if (pathname === '/observers' && method === 'POST') {
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
        res.writeHead(201, {'Content-Type':'application/json'}); res.end(JSON.stringify(row)); return;
      }

      const observerDeleteMatch = pathname.match(/^\/observers\/([^/]+)$/);
      if (observerDeleteMatch && method === 'DELETE') {
        const id = observerDeleteMatch[1];
        const removed = revokeObserver(db, id);
        if (!removed) {
          res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not an observer'})); return;
        }
        try { observerIndex.delete(id); } catch (_) { /* never 500 on live-index update */ }
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); return;
      }

      if (pathname === '/observers' && method === 'GET') {
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(listObservers(db))); return;
      }

      if (pathname === '/topics' && method === 'POST') {
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
        return;
      }

      if (pathname === '/topics' && method === 'GET') {
        const topics = listTopics(db);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(topics));
        return;
      }

      if (pathname === '/agents' && method === 'POST') {
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

        const rawToken = generateToken();
        const token_hash = hashToken(rawToken);
        const agent = registerAgent(db, { id, token_hash, hostname });

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...formatAgent(agent), token: rawToken }));
        return;
      }

      if (pathname === '/agents' && method === 'GET') {
        const onlineOnly = url.searchParams.get('online') === 'true';
        const agents = listAgents(db, onlineOnly);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agents.map(formatAgent)));
        return;
      }

      const agentByIdMatch = pathname.match(/^\/agents\/([^/]+)$/);
      if (agentByIdMatch && method === 'GET') {
        const id = agentByIdMatch[1];
        const agent = getAgentById(db, id);
        if (agent === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(formatAgent(agent)));
        return;
      }

      const agentDeleteMatch = pathname.match(/^\/agents\/([^/]+)$/);
      if (agentDeleteMatch && method === 'DELETE') {
        const id = agentDeleteMatch[1];
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
        return;
      }

      if (pathname === '/messages' && method === 'GET') {
        const agentParam = url.searchParams.get('agent') || undefined;
        const topicParam = url.searchParams.get('topic') || undefined;
        const sinceRaw = url.searchParams.get('since');
        const limitRaw = url.searchParams.get('limit');

        const since = sinceRaw !== null ? parseInt(sinceRaw, 10) : undefined;
        const limit = limitRaw !== null ? parseInt(limitRaw, 10) : undefined;

        const messages = queryMessages(db, {
          agent: agentParam,
          topic: topicParam,
          since: Number.isNaN(since) ? undefined : since,
          limit: Number.isNaN(limit) ? undefined : limit,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(messages));
        return;
      }

      const fileByIdMatch = pathname.match(/^\/files\/([^/]+)$/);
      if (fileByIdMatch && method === 'GET') {
        const id = fileByIdMatch[1];
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
        return;
      }

      if (pathname === '/files' && method === 'POST') {
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

      if (pathname === '/reminders' && method === 'POST') {
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
        return;
      }

      if (pathname === '/reminders' && method === 'GET') {
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
        return;
      }

      const reminderPatchMatch = pathname.match(/^\/reminders\/([^/]+)$/);
      if (reminderPatchMatch && method === 'PATCH') {
        const id = reminderPatchMatch[1];
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
        return;
      }

      const reminderDeleteMatch = pathname.match(/^\/reminders\/([^/]+)$/);
      if (reminderDeleteMatch && method === 'DELETE') {
        const id = reminderDeleteMatch[1];
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
