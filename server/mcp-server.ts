import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Database } from 'bun:sqlite';
import { listAgents } from './db.ts';

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
      },
      required: ['to', 'message'],
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
      },
      required: ['topic', 'message'],
    },
  },
  {
    name: 'mesh_subscribe',
    description: 'Subscribe to a topic',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'mesh_unsubscribe',
    description: 'Unsubscribe from a topic',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
      },
      required: ['topic'],
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
    description: 'Get mesh status',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'mesh_acl_allow',
    description: 'Allow an agent to send messages to this agent',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'mesh_acl_deny',
    description: 'Deny an agent from sending messages to this agent',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
      },
      required: ['agent_id'],
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

export async function startMcpServer(db: Database): Promise<McpServerHandle> {
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

    if (toolName === 'mesh_discover') {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
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
