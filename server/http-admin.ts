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
} from './db.ts';

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

export function startHttpAdmin(
  port: number,
  db: Database,
  adminToken: string
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
