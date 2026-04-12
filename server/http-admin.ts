import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
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
  deleteAgent,
  registerAgent,
  queryMessages,
} from './db.ts';
import { generateToken, hashToken } from './auth.ts';

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
  _maxFileBytes: number = 10_485_760
): Promise<HttpAdminHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
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
        const content = Buffer.from(file.data, 'base64');
        res.writeHead(200, {
          'Content-Type': file.content_type,
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Content-Length': String(content.byteLength),
        });
        res.end(content);
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
