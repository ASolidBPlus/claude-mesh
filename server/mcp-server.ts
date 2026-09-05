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
import { timingSafeEqual } from './auth.ts';

const SERVER_START_MS = Date.now();
import { routeDirect, routePublish, routeSubscribe, routeUnsubscribe } from './router.ts';

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
        admin_token: {
          type: 'string',
          description:
            'MESH_ADMIN_TOKEN. Required: writing an ACL edge is an admin operation on the HTTP plane (#8), and this tool must not be the cheaper door to the same write.',
        },
      },
      required: ['agent_id', 'as_agent', 'admin_token'],
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
        admin_token: {
          type: 'string',
          description:
            'MESH_ADMIN_TOKEN. Required: writing an ACL edge is an admin operation on the HTTP plane (#8), and this tool must not be the cheaper door to the same write.',
        },
      },
      required: ['agent_id', 'as_agent', 'admin_token'],
    },
  },
];

const KNOWN_TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const NOT_IMPLEMENTED_RESPONSE = {
  content: [{ type: 'text' as const, text: '{"error": "not implemented"}' }],
  isError: true,
};

// ──────────────────────────────────────────────────────────────────────────
// MCP tool dispatch
//
// Each tool is a named module-level handler taking a single ToolCtx; the
// TOOL_HANDLERS map (tool name -> handler) replaces what was a 9-arm inline
// `if (toolName === 'mesh_x') {...}` chain inside one anonymous CallTool
// callback, so static analysis sees the per-tool handlers as symbols and the
// dispatch as explicit map edges. Tool names are mutually-exclusive exact
// strings (no precedence), so an O(1) map is the natural structure. The
// ToolHandler return type covers both sync and async handlers. The CallTool
// guard (KNOWN_TOOL_NAMES) and the
// NOT_IMPLEMENTED_RESPONSE fall-through are preserved at the dispatch site.
// ──────────────────────────────────────────────────────────────────────────

type ToolResult = { content: { type: 'text'; text: string }[]; isError: boolean };

interface ToolCtx {
  args: Record<string, unknown>;
  db: Database;
  agentIndex: Map<string, WebSocket>;
  observerIndex: Map<string, WebSocket>;
  /** The configured MESH_ADMIN_TOKEN, for the ACL tools' admin gate (#8). */
  adminToken: string;
}

/**
 * The stdio MCP plane's admin gate (#8).
 *
 * The two ACL tools wrote `acl` rows with no credential at all, while the
 * equivalent HTTP routes (`POST /acl`, `DELETE /acl`) require the admin token.
 * Same write, two doors, one of them unlocked — and DESIGN_FEDERATION P1 will
 * not ship a narrower front door while a wider one stands beside it.
 *
 * Two properties this must hold, both of which have bitten this codebase:
 *
 *   FAIL CLOSED ON AN UNCONFIGURED SECRET. If the server somehow runs with an
 *   empty admin token, an empty `admin_token` argument must NOT match it.
 *   `'' === ''` is the accident that turns a missing secret into a universal
 *   key. (server.ts:27-31 exits at boot when MESH_ADMIN_TOKEN is empty, so
 *   this is defence in depth — but the check here must not DEPEND on that
 *   guard being upstream, because a test harness or a future embedder can
 *   construct the server directly.)
 *
 *   TIMING-SAFE COMPARE, matching resolveAuth (http-admin.ts:87) rather than
 *   requireAdmin's plain `===` (http-admin.ts:61). Where the two existing
 *   doors disagree, the stricter one is the parity worth having.
 */
function adminTokenOk(provided: unknown, configured: string): boolean {
  // These two length checks are MUTUALLY REDUNDANT — either alone closes the
  // '' === '' hole, which is why a mutation that deletes one survives. They
  // are both kept deliberately: the pair states the intent from both sides
  // (an unconfigured server grants nothing; an empty argument is not a
  // credential), and the redundancy is only safe to remove BOTH at once,
  // which is exactly the edit nobody should make. Noted here so a future
  // reader deleting "the dead one" knows the other is load-bearing.
  if (typeof configured !== 'string' || configured.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(provided, configured);
}

/** The refusal, shaped like every other tool error on this plane. */
function unauthorizedResult(): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'UNAUTHORIZED',
          message: 'admin_token is required and must match MESH_ADMIN_TOKEN — no ACL edge was written',
        }),
      },
    ],
    isError: true,
  };
}

type ToolHandler = (ctx: ToolCtx) => Promise<ToolResult> | ToolResult;

function handleMeshDiscover(ctx: ToolCtx): ToolResult {
  const { args, db } = ctx;
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
    last_alive: agent.last_alive ?? null,
    registered_at: agent.registered_at,
  }));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: false,
  };
}

function handleMeshSend(ctx: ToolCtx): ToolResult {
  const { args, db, agentIndex, observerIndex } = ctx;
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

function handleMeshAclAllow(ctx: ToolCtx): ToolResult {
  const { args, db, adminToken } = ctx;
  const { agent_id, as_agent, admin_token } = args as {
    agent_id: string; as_agent: string; admin_token?: unknown;
  };
  // Checked BEFORE the write, so a refusal cannot leave a half-applied grant.
  if (!adminTokenOk(admin_token, adminToken)) return unauthorizedResult();
  const row = aclGrant(db, agent_id, as_agent, as_agent);
  return { content: [{ type: 'text' as const, text: JSON.stringify(row) }], isError: false };
}

function handleMeshBroadcast(ctx: ToolCtx): ToolResult {
  const { args, db, agentIndex, observerIndex } = ctx;
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

function handleMeshSubscribe(ctx: ToolCtx): ToolResult {
  const { args, db } = ctx;
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

function handleMeshUnsubscribe(ctx: ToolCtx): ToolResult {
  const { args, db } = ctx;
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

function handleMeshAclDeny(ctx: ToolCtx): ToolResult {
  const { args, db, adminToken } = ctx;
  const { agent_id, as_agent, admin_token } = args as {
    agent_id: string; as_agent: string; admin_token?: unknown;
  };
  if (!adminTokenOk(admin_token, adminToken)) return unauthorizedResult();
  aclRevoke(db, agent_id, as_agent);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }], isError: false };
}

function handleMeshStatus(ctx: ToolCtx): ToolResult {
  const { args, db } = ctx;
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

// Tool name -> handler. Exact-string keys, mutually exclusive (no precedence),
// so map order is behavior-irrelevant. A name in KNOWN_TOOL_NAMES but absent
// here falls through to NOT_IMPLEMENTED_RESPONSE at the dispatch site (defensive;
// unreachable while this map covers every entry in TOOLS).
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  mesh_send: handleMeshSend,
  mesh_broadcast: handleMeshBroadcast,
  mesh_subscribe: handleMeshSubscribe,
  mesh_unsubscribe: handleMeshUnsubscribe,
  mesh_discover: handleMeshDiscover,
  mesh_status: handleMeshStatus,
  mesh_acl_allow: handleMeshAclAllow,
  mesh_acl_deny: handleMeshAclDeny,
};

export async function startMcpServer(
  db: Database,
  agentIndex: Map<string, WebSocket> = new Map(),
  observerIndex: Map<string, WebSocket> = new Map(),
  /** MESH_ADMIN_TOKEN, for the ACL tools' admin gate (#8). Defaults to '' —
      which `adminTokenOk` treats as "no admin operations are possible",
      NOT as "an empty token matches". An embedder that forgets to pass it
      loses the two ACL tools; it does not silently open them. */
  adminToken = ''
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

    // Named handler per tool; see TOOL_HANDLERS (module scope). A KNOWN tool
    // with no handler entry falls through to NOT_IMPLEMENTED_RESPONSE, exactly
    // as the prior if-chain did.
    const handler = TOOL_HANDLERS[toolName];
    if (handler !== undefined) {
      return handler({ args, db, agentIndex, observerIndex, adminToken });
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
