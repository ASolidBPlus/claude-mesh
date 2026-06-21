import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { listAgents, aclGrant, aclRevoke, getAgentSubscriptions, getAgentById, getPendingMessages } from './db.ts';

const SERVER_START_MS = Date.now();
import { routeDirect, routePublish, routeSubscribe, routeUnsubscribe, routeRequest, PendingRequest } from './router.ts';

export interface McpServerHandle {
  server: Server;
  shutdown(): Promise<void>;
}

const TOOLS = [
  {
    name: 'mesh_send',
    description: 'Send a direct message to an agent',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        message: { type: 'string' },
        ttl_seconds: { type: 'number' },
        as_agent: { type: 'string', description: 'Agent ID acting as the sender' },
      },
      required: ['to', 'message', 'as_agent'],
    },
  },
  {
    name: 'mesh_broadcast',
    description: 'Broadcast a message to a topic',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        message: { type: 'string' },
        ttl_seconds: { type: 'number' },
        as_agent: { type: 'string', description: 'Agent ID acting as the publisher' },
      },
      required: ['topic', 'message', 'as_agent'],
    },
  },
  {
    name: 'mesh_subscribe',
    description: 'Subscribe to a topic',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        as_agent: { type: 'string', description: 'Agent ID subscribing' },
      },
      required: ['topic', 'as_agent'],
    },
  },
  {
    name: 'mesh_unsubscribe',
    description: 'Unsubscribe from a topic',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        as_agent: { type: 'string', description: 'Agent ID unsubscribing' },
      },
      required: ['topic', 'as_agent'],
    },
  },
  {
    name: 'mesh_discover',
    description: 'Discover agents in the mesh',
    inputSchema: {
      type: 'object',
      properties: {
        filter_online: { type: 'boolean' },
        capability: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'mesh_status',
    description: "Get this agent's current mesh connection state: agent_id, online status, active topic subscriptions, pending undelivered message count, and server uptime.",
    inputSchema: {
      type: 'object',
      properties: {
        as_agent: {
          type: 'string',
          description: 'Agent ID to inspect',
        },
      },
      required: ['as_agent'],
    },
  },
  {
    name: 'mesh_acl_allow',
    description: 'Allow an agent to send messages to this agent',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        as_agent: { type: 'string', description: 'Agent ID whose ACL is being modified' },
      },
      required: ['agent_id', 'as_agent'],
    },
  },
  {
    name: 'mesh_acl_deny',
    description: 'Deny an agent from sending messages to this agent',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        as_agent: { type: 'string', description: 'Agent ID whose ACL is being modified' },
      },
      required: ['agent_id', 'as_agent'],
    },
  },
  {
    name: 'mesh_request',
    description: 'Send a request and wait for a response',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        message: { type: 'string' },
        timeout_seconds: { type: 'number' },
      },
      required: ['to', 'message'],
    },
  },
];

const KNOWN_TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const NOT_IMPLEMENTED_RESPONSE = {
  content: [{ type: 'text' as const, text: '{"error": "not implemented"}' }],
  isError: true,
};

export async function startMcpServer(
  db: Database,
  agentIndex: Map<string, WebSocket> = new Map(),
  pendingRequests: Map<string, PendingRequest> = new Map(),
  observerIndex: Map<string, WebSocket> = new Map()
): Promise<McpServerHandle> {
  const server = new Server(
    { name: 'mesh', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
        },
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    if (!KNOWN_TOOL_NAMES.has(toolName)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (toolName === 'mesh_discover') {
      const onlineOnly = args.filter_online === true;
      let agents = listAgents(db, onlineOnly);

      if (typeof args.capability === 'string' && args.capability.length > 0) {
        const cap = args.capability;
        agents = agents.filter(agent => {
          const caps: unknown = JSON.parse(agent.capabilities);
          return Array.isArray(caps) && caps.includes(cap);
        });
      }

      const result = agents.map(agent => ({
        id: agent.id,
        hostname: agent.hostname,
        online: agent.online === 1,
        capabilities: JSON.parse(agent.capabilities) as string[],
        metadata: JSON.parse(agent.metadata) as Record<string, unknown>,
        last_seen: agent.last_seen,
        registered_at: agent.registered_at,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: false,
      };
    }

    if (toolName === 'mesh_send') {
      const { to, message, ttl_seconds, as_agent } = args as {
        to: string; message: string; ttl_seconds?: number; as_agent: string;
      };
      const msgId = crypto.randomUUID();
      const ttl_ms = ttl_seconds !== undefined ? ttl_seconds * 1000 : 300_000;
      const result = routeDirect(db, agentIndex, as_agent, {
        type: 'send', msg_id: msgId, to, payload: message,
        content_type: 'text/plain', ttl_ms,
      }, observerIndex);
      if (result.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, msg_id: result.msg_id }) }], isError: false };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error_code, message: result.error_message }) }], isError: true };
    }

    if (toolName === 'mesh_acl_allow') {
      const { agent_id, as_agent } = args as { agent_id: string; as_agent: string };
      const row = aclGrant(db, agent_id, as_agent, as_agent);
      return { content: [{ type: 'text' as const, text: JSON.stringify(row) }], isError: false };
    }

    if (toolName === 'mesh_broadcast') {
      const { topic, message, ttl_seconds, as_agent } = args as {
        topic: string; message: string; ttl_seconds?: number; as_agent: string;
      };
      const msgId = crypto.randomUUID();
      const ttl_ms = ttl_seconds !== undefined ? ttl_seconds * 1000 : 300_000;
      const result = routePublish(db, agentIndex, as_agent, {
        type: 'publish', msg_id: msgId, topic, payload: message,
        content_type: 'text/plain', ttl_ms,
      }, observerIndex);
      if (result.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, msg_id: msgId }) }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error_code, message: result.error_message }) }],
        isError: true,
      };
    }

    if (toolName === 'mesh_subscribe') {
      const { topic, as_agent } = args as { topic: string; as_agent: string };
      const result = routeSubscribe(db, as_agent, { type: 'subscribe', topic });
      if (result.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, topic }) }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error_code, message: result.error_message }) }],
        isError: true,
      };
    }

    if (toolName === 'mesh_unsubscribe') {
      const { topic, as_agent } = args as { topic: string; as_agent: string };
      const result = routeUnsubscribe(db, as_agent, { type: 'unsubscribe', topic });
      if (result.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, topic }) }],
          isError: false,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error_code, message: result.error_message }) }],
        isError: true,
      };
    }

    if (toolName === 'mesh_acl_deny') {
      const { agent_id, as_agent } = args as { agent_id: string; as_agent: string };
      aclRevoke(db, agent_id, as_agent);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }], isError: false };
    }

    if (toolName === 'mesh_status') {
      const { as_agent } = args as { as_agent?: string };
      if (typeof as_agent !== 'string' || as_agent.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_REQUEST', message: 'as_agent is required' }) }],
          isError: true,
        };
      }
      const agent = getAgentById(db, as_agent);
      if (agent === null) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'AGENT_NOT_FOUND', message: 'agent not found' }) }],
          isError: true,
        };
      }
      const subscriptions = getAgentSubscriptions(db, as_agent);
      const queued_messages = getPendingMessages(db, as_agent).length;
      const server_uptime_ms = Date.now() - SERVER_START_MS;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          agent_id: as_agent,
          online: agent.online === 1,
          subscriptions,
          queued_messages,
          server_uptime_ms,
        }) }],
        isError: false,
      };
    }

    if (toolName === 'mesh_request') {
      const { to, message, as_agent, timeout_seconds } = args as {
        to?: string; message?: string; as_agent?: string; timeout_seconds?: number;
      };
      // Validate required fields
      if (typeof to !== 'string' || typeof message !== 'string' || typeof as_agent !== 'string') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_REQUEST', message: 'to, message, and as_agent are required' }) }],
          isError: true,
        };
      }
      const timeoutSecs = timeout_seconds === undefined ? 30 : timeout_seconds;
      if (timeoutSecs <= 0 || timeoutSecs > 300) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_REQUEST', message: 'timeout_seconds must be between 1 and 300' }) }],
          isError: true,
        };
      }
      const ttl_ms = timeoutSecs * 1000;
      const msgId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();
      const result = routeRequest(db, agentIndex, as_agent, {
        type: 'request',
        msg_id: msgId,
        to,
        payload: message,
        content_type: 'text/plain',
        ttl_ms,
        correlation_id: correlationId,
      }, observerIndex);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error_code, message: result.error_message }) }],
          isError: true,
        };
      }
      // Create a promise that resolves when the response arrives
      const responsePayload = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(correlationId);
          reject(new Error('REQUEST_TIMEOUT'));
        }, ttl_ms);
        pendingRequests.set(correlationId, {
          correlationId,
          fromAgent: as_agent,
          expiresAt: Date.now() + ttl_ms,
          msgId,
          timer,
          startTime: Date.now(),
          resolve,
          reject,
        });
      }).catch((err: Error) => {
        if (err.message === 'REQUEST_TIMEOUT') {
          return null;
        }
        throw err;
      });

      if (responsePayload === null) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'REQUEST_TIMEOUT' }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, response: responsePayload }) }],
        isError: false,
      };
    }

    return NOT_IMPLEMENTED_RESPONSE;
  });

  const handle: McpServerHandle = {
    server,
    async shutdown(): Promise<void> {
      await server.close();
    },
  };

  return handle;
}
